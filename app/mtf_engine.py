"""
Multi-timeframe (1D / 4H / 1H / 15m) prediction engine with a built-in
"why".

How it works
------------
1. SNAPSHOT.  At every 15-minute window open, the market is described as a
   set of discrete readings ("tokens") from nine indicators on each of the
   four timeframes -- e.g. "4H trend UP", "1H RSI<30", "15m MACD- falling"
   -- plus the time of day ("T 08-12h UTC") and weekday/weekend. Only
   fully-closed candles as of the window open are used (plus the OPEN
   price of each still-forming candle, which is already known), so the
   snapshot is identical in the backtest and live and cannot look ahead.

2. PRE-BACKTEST.  The last MTF_BACKTEST_DAYS (7) days are replayed: every
   15-minute window becomes one record = (its tokens, did it finish UP?).
   The miner then searches every 1-, 2- and 3-token "situation"
   ("4H trend UP + 1H RSI<30 + T 08-12h UTC") and keeps only those that
   were right often enough, on enough windows, to be unlikely luck:
     * at least MTF_MIN_SAMPLES windows,
     * a hit-rate z-score vs a coin flip above a cut-off that is
       CALIBRATED on label-shuffled copies of the same data (searching
       thousands of situations always finds lucky ones; the cut-off is
       whatever the same search finds in pure noise),
     * the same direction in BOTH halves of the period (not one lucky
       stretch), and
     * for 2-/3-token situations, clearly better than each of its parts
       (so a rule never just restates a simpler one).

3. PREDICTION.  At window open the live snapshot is matched against the
   kept situations. The strongest matches vote (their historical hit
   rates, shrunk toward 50% for small samples, are averaged in log-odds
   space) and the engine returns UP or DOWN together with the exact
   situations that produced the call, their historical hit rates,
   sample sizes and the times of day they worked. If none of the
   noise-validated situations matches, the engine falls back -- and SAYS
   it did -- first to strong-looking-but-unvalidated situations ("weak
   pattern"), then to a damped naive-Bayes weighing of every current
   reading ("baseline"), so every window gets a call and a reason. The
   tier is shown with the call and scored separately in the backtest.
   (MTF_ALLOW_FALLBACK=0 restores validated-only trading.)

4. HONESTY CHECK.  Alongside the live rules the engine re-runs the same
   procedure with only the first 70% of the week and scores it on the
   untouched last 30%. That out-of-sample accuracy (with its z-score) is
   the number to trust; the in-sample accuracy is shown too but is
   optimistic by construction.

5. STAYS CURRENT.  Every resolved live window is appended to the history
   (oldest dropped, keeping ~7 days) and the rules are re-mined every
   MTF_REFRESH_EVERY_WINDOWS windows, in a worker thread.
"""
import bisect
import math
import random
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from . import config
from . import indicators as ind
from .marketdata import TF_ORDER, TIMEFRAMES, WINDOW_TF, Candle
from .models import Side

BLOCK_HOURS = 4


# ---------------------------------------------------------------------------
# Snapshot: candles -> indicator series -> discrete tokens
# ---------------------------------------------------------------------------

@dataclass
class Prepared:
    """One timeframe's candles + precomputed indicator series."""
    candles: List[Candle]
    open_times: List[float]
    s: Dict[str, list]


def prepare(candles: List[Candle]) -> Prepared:
    closes = [c.close for c in candles]
    highs = [c.high for c in candles]
    lows = [c.low for c in candles]
    vols = [c.volume for c in candles]
    adx_v, pdi, mdi = ind.adx(highs, lows, closes, 14)
    return Prepared(
        candles=candles,
        open_times=[c.open_time for c in candles],
        s={
            "rsi": ind.rsi(closes, 14),
            "macd_hist": ind.macd(closes)[2],
            "ema20": ind.ema(closes, 20),
            "ema50": ind.ema(closes, 50),
            "pctb": ind.bollinger_pct_b(closes, 20, 2.0),
            "stoch": ind.stochastic_k(highs, lows, closes, 14, 3),
            "adx": adx_v, "pdi": pdi, "mdi": mdi,
            "atr": ind.atr(highs, lows, closes, 14),
            "vol_sma": ind.sma(vols, 20),
        },
    )


def prepare_frames(frames: Dict[str, List[Candle]]) -> Optional[Dict[str, Prepared]]:
    if any(not frames.get(tf) for tf in TF_ORDER):
        return None
    return {tf: prepare(frames[tf]) for tf in TF_ORDER}


_NEEDED = ("rsi", "macd_hist", "ema20", "ema50", "pctb", "stoch", "adx", "pdi", "mdi", "atr", "vol_sma")


def _frame_tokens(tf: str, p: Prepared, i: int, forming_open: float, price_now: float):
    """Tokens + human-readable readings for the last closed candle i."""
    s = p.s
    if i < 1 or s["macd_hist"][i - 1] is None:
        return None
    v = {k: s[k][i] for k in _NEEDED}
    if any(x is None for x in v.values()):
        return None
    c = p.candles[i]
    close = c.close

    rsi_v = v["rsi"]
    rsi_t = ("RSI<30" if rsi_v < 30 else "RSI30-45" if rsi_v < 45 else
             "RSI45-55" if rsi_v <= 55 else "RSI55-70" if rsi_v <= 70 else "RSI>70")

    h, hp = v["macd_hist"], s["macd_hist"][i - 1]
    if h >= 0:
        macd_t = "MACD+ rising" if h > hp else "MACD+ fading"
    else:
        macd_t = "MACD- falling" if h < hp else "MACD- recovering"

    e20, e50 = v["ema20"], v["ema50"]
    trend = "UP" if (e20 > e50 and close > e20) else "DOWN" if (e20 < e50 and close < e20) else "MIXED"

    b = v["pctb"]
    bb_t = ("BB below/at lower" if b < 0.1 else "BB lower-half" if b < 0.5 else
            "BB upper-half" if b < 0.9 else "BB above/at upper")

    st = v["stoch"]
    st_t = "STOCH<20" if st < 20 else "STOCH>80" if st > 80 else "STOCH mid"

    if v["adx"] < 20:
        adx_t = "ADX<20 range"
    else:
        adx_t = "ADX>=20 +DI lead" if v["pdi"] > v["mdi"] else "ADX>=20 -DI lead"

    vr = c.volume / v["vol_sma"] if v["vol_sma"] else 1.0
    vol_t = "VOL low" if vr < 0.8 else "VOL high" if vr > 1.5 else "VOL normal"

    candle_t = "candle GREEN" if c.close > c.open else "candle RED"

    atr_v = v["atr"]
    # Price vs the still-forming candle's open. For the timeframe that IS the
    # window (15m) that candle has only just opened, so the reading is always
    # ~0 and carries no information -- leave it out.
    is_window_tf = TIMEFRAMES[tf][1] == config.WINDOW_SECONDS
    move_atr = None if is_window_tf else ((price_now - forming_open) / atr_v if atr_v else 0.0)
    labels = [rsi_t, macd_t, f"trend {trend}", bb_t, st_t, adx_t, vol_t, candle_t]
    if move_atr is not None:
        labels.append("now >0.5ATR above open" if move_atr > 0.5 else
                      "now >0.5ATR below open" if move_atr < -0.5 else "now near open")
    tokens = [f"{tf} {t}" for t in labels]
    readings = {
        "rsi": round(rsi_v, 1), "macd_hist": round(h, 4), "macd_state": macd_t,
        "trend": trend, "ema20": round(e20, 2), "ema50": round(e50, 2),
        "pctb": round(b, 2), "stoch": round(st, 1), "adx": round(v["adx"], 1),
        "pdi": round(v["pdi"], 1), "mdi": round(v["mdi"], 1),
        "atr_pct": round(atr_v / close * 100, 3) if close else None,
        "vol_ratio": round(vr, 2), "candle": "GREEN" if c.close > c.open else "RED",
        "now_vs_open_atr": round(move_atr, 2) if move_atr is not None else None,
    }
    return tokens, readings


def block_label(block: int) -> str:
    return f"T {block * BLOCK_HOURS:02d}-{block * BLOCK_HOURS + BLOCK_HOURS:02d}h UTC"


def block_of(ts: float) -> int:
    return int((ts // 3600) % 24) // BLOCK_HOURS


def time_tokens(t: float) -> List[str]:
    dt = datetime.fromtimestamp(t, tz=timezone.utc)
    return [block_label(block_of(t)), "DAY weekend" if dt.weekday() >= 5 else "DAY weekday"]


def window_tokens(prepared: Dict[str, Prepared], t: float, price_now: float
                  ) -> Optional[Tuple[frozenset, Dict[str, dict]]]:
    """Snapshot as of window open `t` (unix seconds). None if any timeframe
    lacks converged indicators or its newest closed candle isn't the one
    expected (data gap / stale feed) -- never guess."""
    tokens: List[str] = []
    readings: Dict[str, dict] = {}
    for tf in TF_ORDER:
        p = prepared[tf]
        secs = TIMEFRAMES[tf][1]
        i = bisect.bisect_right(p.open_times, t - secs) - 1     # last candle that has CLOSED by t
        if i < 1 or p.open_times[i] != (t // secs) * secs - secs:
            return None
        forming_open = price_now
        if i + 1 < len(p.candles) and p.candles[i + 1].open_time <= t:
            forming_open = p.candles[i + 1].open
        res = _frame_tokens(tf, p, i, forming_open, price_now)
        if res is None:
            return None
        toks, rd = res
        tokens.extend(toks)
        readings[tf] = rd
    tokens.extend(time_tokens(t))
    return frozenset(tokens), readings


def price_at(window_candles: List[Candle], t: float) -> Optional[float]:
    """Window-open price: the open of the window-timeframe (15m) candle
    starting at t, or (if Binance hasn't listed it yet) the close of the one
    that just ended."""
    w = config.WINDOW_SECONDS
    for c in reversed(window_candles):
        if c.open_time == t:
            return c.open
        if c.open_time == t - w:
            return c.close
        if c.open_time < t - w:
            break
    return None


@dataclass
class WindowRecord:
    ts: float            # window open, unix seconds
    tokens: frozenset
    up: bool


def build_records(data: Dict[str, List[Candle]], now: Optional[float] = None,
                  days: Optional[float] = None) -> List[WindowRecord]:
    """Replay history into one record per completed 15-minute window."""
    now = now if now is not None else time.time()
    days = days if days is not None else config.MTF_BACKTEST_DAYS
    prepared = prepare_frames(data)
    if prepared is None:
        return []
    start = now - days * 86400
    out: List[WindowRecord] = []
    w = config.WINDOW_SECONDS
    for c in data[WINDOW_TF]:
        t = c.open_time
        if t < start or t + w > now or t % w != 0:
            continue
        res = window_tokens(prepared, t, c.open)
        if res is None:
            continue
        # Polymarket: "Up" if the end price is >= the start price.
        out.append(WindowRecord(ts=t, tokens=res[0], up=c.close >= c.open))
    out.sort(key=lambda r: r.ts)
    return out


# ---------------------------------------------------------------------------
# Rules ("situations") and the miner
# ---------------------------------------------------------------------------

def _tok_key(tok: str):
    prefix = tok.split(" ", 1)[0]
    return (TF_ORDER.index(prefix) if prefix in TF_ORDER else 99, tok)


@dataclass
class Rule:
    tokens: tuple
    token_set: frozenset
    n: int
    ups: int
    direction: str            # "UP" | "DOWN" -- the side this situation historically favoured
    hits: int
    hit_rate: float
    z: float
    p_up: float               # P(UP), shrunk toward 0.5 for small samples
    time_profile: Dict[int, list] = field(default_factory=dict)   # block -> [n, hits]
    recent: list = field(default_factory=list)                    # [(ts, correct)] newest first
    _mask: int = 0

    @property
    def text(self) -> str:
        return " + ".join(self.tokens)

    def to_dict(self) -> dict:
        blocks = sorted(((b, n, h) for b, (n, h) in self.time_profile.items() if n >= 5),
                        key=lambda x: (x[2] / x[1], x[1]), reverse=True)
        best = None
        if blocks:
            b, n, h = blocks[0]
            best = {"time": block_label(b), "n": n, "hit_rate": round(h / n, 3)}
        return {
            "text": self.text, "direction": self.direction, "n": self.n, "hits": self.hits,
            "hit_rate": round(self.hit_rate, 3), "z": round(self.z, 2), "p_up": round(self.p_up, 3),
            "best_time": best,
            "recent": [{"ts": ts, "ok": ok} for ts, ok in self.recent],
        }


@dataclass
class _Index:
    """Bitmask index over one set of records (see mine_rules)."""
    toks: List[str]
    M: List[int]
    up_mask: int
    h1: int
    h2: int
    n_records: int


def _build_index(records: List[WindowRecord], min_n: int) -> _Index:
    # Each token -> bitmask over records (bit i set = record i has the token).
    # Counting a situation = AND of masks + popcount: fast enough for
    # thousands of combinations in pure Python.
    N = len(records)
    masks: Dict[str, int] = {}
    up_mask = 0
    for idx, r in enumerate(records):
        bit = 1 << idx
        if r.up:
            up_mask |= bit
        for tok in r.tokens:
            masks[tok] = masks.get(tok, 0) | bit
    half = N // 2
    h1 = (1 << half) - 1
    h2 = ((1 << N) - 1) ^ h1
    toks = sorted((t for t, m in masks.items() if m.bit_count() >= min_n), key=_tok_key)
    return _Index(toks=toks, M=[masks[t] for t in toks], up_mask=up_mask, h1=h1, h2=h2, n_records=N)


def _search(ix: _Index, up_mask: int, *, min_n: int, min_z: float, parsimony: float,
            max_size: int, prior: float, track_max: bool):
    """Enumerate 1-, 2- and 3-token situations. Returns (rules, max_z).

    Every candidate must have >= min_n windows, the same direction in both
    halves of the period, and (for 2-/3-token ones) beat each of its parts by
    `parsimony`. Then: normal mode keeps those with z >= min_z; track_max mode
    (used on label-shuffled data to calibrate min_z) builds no rules and just
    records the best z any such candidate reached."""
    toks, M, T = ix.toks, ix.M, len(ix.toks)
    h1, h2 = ix.h1, ix.h2
    min_half = max(5, min_n // 4)
    best = {"z": 0.0}

    def stats(m):
        return m.bit_count(), (m & up_mask).bit_count()

    def parent_rate(n, u, direction):
        return (u / n) if direction == "UP" else 1.0 - u / n

    def try_rule(idxs, m, parents):
        n, u = stats(m)
        if n < min_n:
            return None
        direction = "UP" if 2 * u >= n else "DOWN"
        hits = u if direction == "UP" else n - u
        z = (2 * hits - n) / math.sqrt(n)
        if not track_max and z < min_z:
            return None
        if track_max and z <= best["z"]:
            return None          # can't raise the max -- skip the remaining checks
        n1, u1 = (m & h1).bit_count(), (m & h1 & up_mask).bit_count()
        n2, u2 = (m & h2).bit_count(), (m & h2 & up_mask).bit_count()
        hits1 = u1 if direction == "UP" else n1 - u1
        hits2 = u2 if direction == "UP" else n2 - u2
        if n1 < min_half or n2 < min_half or 2 * hits1 < n1 or 2 * hits2 < n2:
            return None
        hit_rate = hits / n
        if parents:
            best_parent = max(parent_rate(pn, pu, direction) for pn, pu in parents if pn > 0)
            if hit_rate < best_parent + parsimony:
                return None
        if track_max:
            best["z"] = z
            return None
        names = tuple(sorted((toks[i] for i in idxs), key=_tok_key))
        p_up = (u + prior / 2.0) / (n + prior)
        return Rule(tokens=names, token_set=frozenset(names), n=n, ups=u, direction=direction,
                    hits=hits, hit_rate=hit_rate, z=z, p_up=p_up, _mask=m)

    rules: List[Rule] = []
    single_stats = [stats(m) for m in M]
    for i in range(T):
        r = try_rule((i,), M[i], None)
        if r:
            rules.append(r)

    pair_masks: Dict[Tuple[int, int], int] = {}
    pair_stats: Dict[Tuple[int, int], Tuple[int, int]] = {}
    if max_size >= 2:
        for i in range(T):
            for j in range(i + 1, T):
                m = M[i] & M[j]
                if m.bit_count() < min_n:
                    continue
                pair_masks[(i, j)] = m
                pair_stats[(i, j)] = stats(m)
                r = try_rule((i, j), m, [single_stats[i], single_stats[j]])
                if r:
                    rules.append(r)

    if max_size >= 3:
        for (i, j), mij in pair_masks.items():
            for k in range(j + 1, T):
                m = mij & M[k]
                if m.bit_count() < min_n:
                    continue
                pik, pjk = pair_stats.get((i, k)), pair_stats.get((j, k))
                if pik is None or pjk is None:
                    continue
                r = try_rule((i, j, k), m, [pair_stats[(i, j)], pik, pjk])
                if r:
                    rules.append(r)
    return rules, best["z"]


def mine_rules(records: List[WindowRecord], *, min_n: Optional[int] = None, min_z: Optional[float] = None,
               max_rules: Optional[int] = None, parsimony: Optional[float] = None,
               max_size: Optional[int] = None, prior: Optional[float] = None,
               permutations: Optional[int] = None, alpha: Optional[float] = None,
               seed: int = 20260919) -> Tuple[List[Rule], float]:
    """Returns (rules, z_threshold_used).

    Searching thousands of candidate situations on ~2000 windows WILL turn
    up impressive-looking ones by pure luck (on random data, dozens pass a
    fixed z cut-off). So the z cut-off is calibrated against the data
    itself: the search is repeated on `permutations` copies with the
    up/down outcomes randomly shuffled -- where, by construction, no
    situation can have real predictive power -- and the cut-off is set at
    the (1-alpha) quantile of the best z those shuffled searches produce.
    A situation therefore survives only if it beats what the same search
    finds in noise ~(1-alpha) of the time, whatever the number of
    candidates. MTF_MIN_Z is a floor under that."""
    min_n = config.MTF_MIN_SAMPLES if min_n is None else min_n
    min_z = config.MTF_MIN_Z if min_z is None else min_z
    max_rules = config.MTF_MAX_RULES if max_rules is None else max_rules
    parsimony = config.MTF_PARSIMONY if parsimony is None else parsimony
    max_size = config.MTF_MAX_RULE_SIZE if max_size is None else max_size
    prior = config.MTF_SHRINK_PRIOR if prior is None else prior
    permutations = config.MTF_PERMUTATIONS if permutations is None else permutations
    alpha = config.MTF_ALPHA if alpha is None else alpha

    N = len(records)
    if N < 2 * min_n:
        return [], min_z

    ix = _build_index(records, min_n)
    common = dict(min_n=min_n, parsimony=parsimony, max_size=max_size, prior=prior)

    z_thr = min_z
    if permutations > 0:
        rng = random.Random(seed)
        outcomes = [r.up for r in records]
        null_max: List[float] = []
        for _ in range(permutations):
            rng.shuffle(outcomes)
            bits = "".join("1" if outcomes[i] else "0" for i in range(N - 1, -1, -1))
            _, mz = _search(ix, int(bits, 2), min_z=0.0, track_max=True, **common)
            null_max.append(mz)
        null_max.sort()
        q = null_max[min(len(null_max) - 1, max(0, math.ceil((1 - alpha) * len(null_max)) - 1))]
        z_thr = max(min_z, q)

    rules, _ = _search(ix, ix.up_mask, min_z=z_thr, track_max=False, **common)
    rules.sort(key=lambda r: (r.z, r.n), reverse=True)
    rules = rules[:max_rules]

    # Fill in "when did it work": time-of-day profile + latest matches.
    rec_block = [block_of(r.ts) for r in records]
    for r in rules:
        m = r._mask
        prof: Dict[int, list] = {}
        recent: list = []
        while m:
            idx = m.bit_length() - 1
            m ^= 1 << idx
            rec = records[idx]
            ok = (rec.up == (r.direction == "UP"))
            cell = prof.setdefault(rec_block[idx], [0, 0])
            cell[0] += 1
            cell[1] += 1 if ok else 0
            if len(recent) < 6:
                recent.append((rec.ts, ok))
        r.time_profile, r.recent, r._mask = prof, recent, 0
    return rules, z_thr


# ---------------------------------------------------------------------------
# Prediction (three tiers, strongest evidence first)
# ---------------------------------------------------------------------------
#
#   validated  situations that passed the noise-calibrated test in mine_rules
#   candidate  situations that looked strong in the last 7 days (z >=
#              MTF_CANDIDATE_MIN_Z, same consistency / parsimony filters) but did
#              NOT clear the noise-calibrated bar -- so they may well be luck
#   baseline   nothing above matches: weigh every current reading at once with a
#              damped naive-Bayes vote, so there is ALWAYS a call and a "why"
#
# The tier is reported with every call so weak evidence is never presented as
# strong, and the out-of-sample backtest scores each tier separately.

TIER_LABELS = {
    "validated": "VALIDATED situation (passed the noise test)",
    "candidate": "WEAK pattern (strong in last 7d, NOT noise-validated)",
    "baseline": "BASELINE (no strong pattern; all readings weighed together)",
}


@dataclass
class Prediction:
    side: Side
    p_up: float
    confidence: float          # P(chosen side)
    tier: str                  # "validated" | "candidate" | "baseline"
    n_matched: int             # matched situations (or readings weighed, for baseline)
    n_for: int                 # of those, how many agree with the chosen side
    n_against: int
    reasons: List[dict]        # top situations / readings behind the call
    readings: Dict[str, dict]  # per-timeframe indicator readings at window open


def _logit(p: float) -> float:
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def _vote(rules: List[Rule], tokens: frozenset, top_k: int):
    matched = [r for r in rules if r.token_set <= tokens]
    if not matched:
        return None
    matched.sort(key=lambda r: (r.z, r.n), reverse=True)
    top = matched[:top_k]
    p_up = _sigmoid(sum(_logit(r.p_up) for r in top) / len(top))
    side = Side.UP if p_up >= 0.5 else Side.DOWN
    return matched, top, p_up, side


class Baseline:
    """Always-available fallback: for every reading in the current snapshot,
    how did windows with that reading tend to end (shrunk toward the week's
    base up-rate)? The per-reading log-odds shifts are summed and damped by
    sqrt(#readings) because the readings overlap heavily (RSI, MACD and trend
    on one timeframe mostly say the same thing) -- summing them raw would be
    wildly overconfident. The week's base rate is subtracted out so a drifting
    week doesn't make it always say UP."""

    def __init__(self, records: List[WindowRecord]):
        n = len(records)
        ups = sum(1 for r in records if r.up)
        self.base = (ups + 1.0) / (n + 2.0)
        stats: Dict[str, list] = {}
        for r in records:
            for tok in r.tokens:
                c = stats.setdefault(tok, [0, 0])
                c[0] += 1
                c[1] += 1 if r.up else 0
        self.stats = stats

    def vote(self, tokens: frozenset, want_reasons: bool = True, top_n: int = 5):
        prior, min_n = config.MTF_BASELINE_PRIOR, config.MTF_BASELINE_MIN_TOKEN_N
        base_logit = _logit(self.base)
        contribs = []
        for tok in tokens:
            st = self.stats.get(tok)
            if not st or st[0] < min_n:
                continue
            n, u = st
            p = (u + prior * self.base) / (n + prior)
            contribs.append((_logit(p) - base_logit, tok, n, u))
        if not contribs:
            return None
        p_up = _sigmoid(sum(c[0] for c in contribs) / math.sqrt(len(contribs)))
        side_up = p_up >= 0.5
        n_for = sum(1 for c in contribs if (c[0] >= 0) == side_up)
        reasons: List[dict] = []
        if want_reasons:
            for llr, tok, n, u in sorted(contribs, key=lambda c: abs(c[0]), reverse=True)[:top_n]:
                direction = "UP" if llr >= 0 else "DOWN"
                hits = u if direction == "UP" else n - u
                reasons.append({
                    "text": tok, "direction": direction, "n": n, "hits": hits,
                    "hit_rate": round(hits / n, 3), "z": round((2 * hits - n) / math.sqrt(n), 2),
                    "p_up": round(u / n, 3), "best_time": None, "recent": [],
                })
        return {"p_up": p_up, "n_used": len(contribs), "n_for": n_for, "reasons": reasons}


@dataclass
class ModelSet:
    rules: List[Rule]                 # validated
    candidates: List[Rule]            # strong-looking but not noise-validated
    baseline: Optional[Baseline]
    z_threshold: float


def build_models(records: List[WindowRecord]) -> ModelSet:
    rules, z_thr = mine_rules(records)
    candidates, _ = mine_rules(records, permutations=0, min_z=config.MTF_CANDIDATE_MIN_Z)
    return ModelSet(rules=rules, candidates=candidates,
                    baseline=Baseline(records) if records else None, z_threshold=z_thr)


@dataclass
class Decision:
    tier: str
    side: Side
    p_up: float
    n_matched: int
    n_for: int
    reasons: List[dict]


def _decide(ms: Optional[ModelSet], tokens: frozenset, top_k: int, allow_fallback: bool,
            want_reasons: bool = True) -> Optional[Decision]:
    if ms is None:
        return None
    tiers = [("validated", ms.rules)]
    if allow_fallback:
        tiers.append(("candidate", ms.candidates))
    for tier, rules in tiers:
        v = _vote(rules, tokens, top_k)
        if v is not None:
            matched, top, p_up, side = v
            return Decision(tier=tier, side=side, p_up=p_up, n_matched=len(matched),
                            n_for=sum(1 for r in matched if r.direction == side.value),
                            reasons=[r.to_dict() for r in top] if want_reasons else [])
    if allow_fallback and ms.baseline is not None:
        b = ms.baseline.vote(tokens, want_reasons=want_reasons)
        if b is not None:
            side = Side.UP if b["p_up"] >= 0.5 else Side.DOWN
            return Decision(tier="baseline", side=side, p_up=b["p_up"], n_matched=b["n_used"],
                            n_for=b["n_for"], reasons=b["reasons"])
    return None


def _score(records: List[WindowRecord], ms: ModelSet, top_k: int, allow_fallback: bool) -> dict:
    n = len(records)
    predicted = correct = 0
    blocks: Dict[int, list] = {}
    tiers: Dict[str, list] = {}
    for rec in records:
        d = _decide(ms, rec.tokens, top_k, allow_fallback, want_reasons=False)
        if d is None:
            continue
        ok = (d.side == Side.UP) == rec.up
        predicted += 1
        correct += 1 if ok else 0
        cell = blocks.setdefault(block_of(rec.ts), [0, 0])
        cell[0] += 1
        cell[1] += 1 if ok else 0
        tc = tiers.setdefault(d.tier, [0, 0])
        tc[0] += 1
        tc[1] += 1 if ok else 0
    return {
        "windows": n, "predicted": predicted, "correct": correct,
        "coverage": round(predicted / n, 3) if n else None,
        "accuracy": round(correct / predicted, 3) if predicted else None,
        "z": round((2 * correct - predicted) / math.sqrt(predicted), 2) if predicted else None,
        "up_rate": round(sum(1 for r in records if r.up) / n, 3) if n else None,
        "by_time": [{"time": block_label(b), "n": c[0], "accuracy": round(c[1] / c[0], 3)}
                    for b, c in sorted(blocks.items())],
        "by_tier": {t: {"predicted": c[0], "correct": c[1], "accuracy": round(c[1] / c[0], 3)}
                    for t, c in tiers.items()},
    }


def evaluate(records: List[WindowRecord], live: ModelSet, top_k: Optional[int] = None) -> dict:
    """In-sample score of the live models + an honest out-of-sample score:
    build everything from the first 70% of the period, score it on the
    untouched last 30% -- overall and per tier."""
    top_k = config.MTF_TOP_RULES if top_k is None else top_k
    allow = config.MTF_ALLOW_FALLBACK
    n = len(records)
    summary = {"windows": n, "n_rules": len(live.rules), "n_candidates": len(live.candidates),
               "z_threshold": round(live.z_threshold, 2), "fallback": allow}
    if n < 100:
        return summary
    split = int(n * 0.7)
    train, test = records[:split], records[split:]
    ms_tr = build_models(train)
    summary["out_of_sample"] = {**_score(test, ms_tr, top_k, allow), "train_windows": len(train),
                                "rules": len(ms_tr.rules), "candidates": len(ms_tr.candidates),
                                "z_threshold": round(ms_tr.z_threshold, 2)}
    summary["in_sample"] = _score(records, live, top_k, allow)
    summary["period_start"] = records[0].ts
    summary["period_end"] = records[-1].ts + config.WINDOW_SECONDS
    return summary


class MTFPredictor:
    """Holds the rolling history, the fitted models (validated situations,
    weaker candidates, baseline), and the backtest summary. One instance
    lives for the process lifetime."""

    def __init__(self):
        self.records: List[WindowRecord] = []
        self.models: Optional[ModelSet] = None
        self.summary: dict = {}
        self.built_at: Optional[float] = None
        self.windows_since_rebuild = 0
        self.rebuilding = False
        self.live_added = 0
        self.total_predictions = 0
        self.correct_predictions = 0
        self.tier_live: Dict[str, list] = {}
        self._lock = threading.Lock()

    @property
    def rules(self) -> List[Rule]:
        return self.models.rules if self.models else []

    @property
    def candidates(self) -> List[Rule]:
        return self.models.candidates if self.models else []

    # ---- history / (re)building -------------------------------------------

    def load_records(self, records: List[WindowRecord]):
        with self._lock:
            self.records = sorted(records, key=lambda r: r.ts)
        self.rebuild()

    def add_record(self, ts: float, tokens: frozenset, up: bool):
        with self._lock:
            if self.records and ts <= self.records[-1].ts:
                return
            self.records.append(WindowRecord(ts=ts, tokens=tokens, up=up))
            cap = int(config.MTF_BACKTEST_DAYS * 86400 / config.WINDOW_SECONDS)
            if len(self.records) > cap:
                del self.records[: len(self.records) - cap]
            self.windows_since_rebuild += 1
            self.live_added += 1

    def needs_rebuild(self) -> bool:
        return (not self.rebuilding) and self.windows_since_rebuild >= config.MTF_REFRESH_EVERY_WINDOWS

    def rebuild(self):
        """Blocking (several seconds) -- call from a worker thread while live."""
        with self._lock:
            if self.rebuilding:
                return
            self.rebuilding = True
            snapshot = list(self.records)
            self.windows_since_rebuild = 0
        try:
            models = build_models(snapshot)
            summary = evaluate(snapshot, models)
            # single assignments: readers see either the old or the new models, never a mix
            self.models, self.summary, self.built_at = models, summary, time.time()
        finally:
            self.rebuilding = False

    # ---- live prediction --------------------------------------------------------

    def predict(self, tokens: frozenset, readings: Dict[str, dict]) -> Optional[Prediction]:
        d = _decide(self.models, tokens, config.MTF_TOP_RULES, config.MTF_ALLOW_FALLBACK)
        if d is None:
            return None
        conf = d.p_up if d.side == Side.UP else 1 - d.p_up
        return Prediction(
            side=d.side, p_up=d.p_up, confidence=conf, tier=d.tier,
            n_matched=d.n_matched, n_for=d.n_for, n_against=d.n_matched - d.n_for,
            reasons=d.reasons, readings=readings,
        )

    def record_result(self, predicted: Optional[Side], actual_up: bool, tier: Optional[str] = None):
        if predicted is None:
            return
        ok = (predicted == Side.UP) == actual_up
        self.total_predictions += 1
        self.correct_predictions += 1 if ok else 0
        if tier:
            c = self.tier_live.setdefault(tier, [0, 0])
            c[0] += 1
            c[1] += 1 if ok else 0

    # ---- text / dashboard -------------------------------------------------------

    @staticmethod
    def explain(pred: Prediction, max_reasons: int = 3) -> str:
        parts = []
        for r in pred.reasons[:max_reasons]:
            when = (f", best {r['best_time']['time']} ({r['best_time']['hit_rate']:.0%} of {r['best_time']['n']})"
                    if r.get("best_time") else "")
            parts.append(f"[{r['text']} -> {r['direction']} {r['hit_rate']:.0%} of {r['n']} windows, z={r['z']}{when}]")
        what = "readings weighed" if pred.tier == "baseline" else "situations matched"
        return (f"{pred.tier.upper()} {pred.side.value} {pred.confidence:.0%} | {pred.n_matched} {what} "
                f"({pred.n_for} agree, {pred.n_against} disagree) | " + " ".join(parts))

    def status(self) -> dict:
        live_acc = (round(100 * self.correct_predictions / self.total_predictions, 1)
                    if self.total_predictions else None)
        return {
            "history_windows": len(self.records),
            "live_windows_added": self.live_added,
            "n_rules": len(self.rules),
            "n_candidates": len(self.candidates),
            "fallback": config.MTF_ALLOW_FALLBACK,
            "built_at": self.built_at,
            "rebuilding": self.rebuilding,
            "summary": self.summary,
            "top_rules": [r.to_dict() for r in self.rules[:12]],
            "top_candidates": [r.to_dict() for r in self.candidates[:10]],
            "live_predictions": self.total_predictions,
            "live_correct": self.correct_predictions,
            "live_accuracy": live_acc,
            "live_by_tier": {t: {"predicted": c[0], "correct": c[1], "accuracy": round(c[1] / c[0], 3)}
                             for t, c in self.tier_live.items()},
        }
