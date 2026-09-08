"""
Paper trading ledger for the 4-engine pooled bot.

Each engine spends its own $ENTRY_DOLLARS to open its one position per
window, same as any normal trade. But at CLOSE (whether via take-profit,
stop-loss, or hold-to-resolution), the engine does NOT keep its own
result:

  - The owning engine is credited back EXACTLY what it spent (entry cost
    + entry fee) -- net zero effect on its own balance from its own
    trade, win or lose.
  - The trade's actual raw P&L (proceeds - entry cost - entry fee - exit
    fee, which can be positive OR negative) is split three ways and
    applied to the OTHER three engines' balances: if the trade was a
    profit, each of the other three receives +raw_pnl/3; if it was a
    loss, each of the other three's balance is reduced by raw_pnl/3
    (i.e. they "cover" the loss equally).

This is intentionally NOT a shared pool where each engine keeps its own
result and just also gets a share of others' -- the owning engine's own
outcome is fully transferred away, every time, in both directions.
"""
import itertools
import logging
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

_default_log = logging.getLogger("engine")

_id_counter = itertools.count(1)


@dataclass
class EnginePosition:
    id: int
    engine_label: str
    window_start: int
    asset: str
    outcome: str
    token_id: str
    opened_at: float
    shares: float
    avg_entry_price: float
    entry_cost: float          # shares * avg_entry_price
    entry_fee: float
    status: str = "OPEN"       # OPEN | CLOSED_TP | CLOSED_SL | RESOLVED
    closed_at: Optional[float] = None
    exit_price: Optional[float] = None
    exit_proceeds: Optional[float] = None
    exit_fee: Optional[float] = None
    raw_pnl: Optional[float] = None       # proceeds - entry_cost - entry_fee - exit_fee
    resolution_won: Optional[bool] = None  # only set if closed via RESOLVED


@dataclass
class CohortRedistribution:
    window_start: int
    completed_at: float
    per_engine_raw_pnl: Dict[str, float]
    per_engine_balance_delta: Dict[str, float]  # what actually happened to each balance


@dataclass
class WindowCohort:
    window_start: int
    positions: Dict[str, EnginePosition] = field(default_factory=dict)  # engine_label -> position
    redistributed: bool = False


class PoolLedger:
    def __init__(self, engine_labels: List[str], starting_capital: float,
                 log: Optional[logging.Logger] = None):
        self.balances: Dict[str, float] = {lbl: starting_capital for lbl in engine_labels}
        self.starting_capital = starting_capital
        self.engine_labels = list(engine_labels)
        self.history: List[EnginePosition] = []
        self.cohort_history: List[CohortRedistribution] = []
        self.log = log or _default_log

    # ---- entry ------------------------------------------------------------
    def open_position(self, engine_label: str, window_start: int, asset: str, outcome: str,
                       token_id: str, shares: float, avg_price: float,
                       entry_cost: float, entry_fee: float) -> EnginePosition:
        pos = EnginePosition(
            id=next(_id_counter),
            engine_label=engine_label,
            window_start=window_start,
            asset=asset,
            outcome=outcome,
            token_id=token_id,
            opened_at=time.time(),
            shares=shares,
            avg_entry_price=avg_price,
            entry_cost=entry_cost,
            entry_fee=entry_fee,
        )
        self.balances[engine_label] -= (entry_cost + entry_fee)
        self.log.info(
            "OPEN %s window=%s %s-%s shares=%.4f @%.4f cost=%.4f fee=%.4f balance=%.2f",
            engine_label, window_start, asset, outcome, shares, avg_price,
            entry_cost, entry_fee, self.balances[engine_label],
        )
        return pos

    # ---- close (TP / SL) -------------------------------------------------------
    def close_position_market(self, pos: EnginePosition, status: str, exit_price: float,
                               exit_proceeds: float, exit_fee: float) -> EnginePosition:
        """status: 'CLOSED_TP' or 'CLOSED_SL'"""
        pos.status = status
        pos.closed_at = time.time()
        pos.exit_price = exit_price
        pos.exit_proceeds = exit_proceeds
        pos.exit_fee = exit_fee
        pos.raw_pnl = exit_proceeds - pos.entry_cost - pos.entry_fee - exit_fee
        self.history.append(pos)
        self.log.info(
            "%s %s window=%s proceeds=%.4f raw_pnl=%.4f (pre-redistribution)",
            status, pos.engine_label, pos.window_start, exit_proceeds, pos.raw_pnl,
        )
        return pos

    # ---- close (hold-to-resolution / time decay) ---------------------------------
    def resolve_position(self, pos: EnginePosition, won: bool) -> EnginePosition:
        """Official (or CLOB-fallback) resolution: pays $1/share if won,
        $0/share if not. No exit fee on a redemption (it's a claim, not a
        trade)."""
        payout = pos.shares * (1.0 if won else 0.0)
        pos.status = "RESOLVED"
        pos.closed_at = time.time()
        pos.exit_price = 1.0 if won else 0.0
        pos.exit_proceeds = payout
        pos.exit_fee = 0.0
        pos.resolution_won = won
        pos.raw_pnl = payout - pos.entry_cost - pos.entry_fee
        self.history.append(pos)
        self.log.info(
            "RESOLVE %s window=%s won=%s payout=%.4f raw_pnl=%.4f (pre-redistribution)",
            pos.engine_label, pos.window_start, won, payout, pos.raw_pnl,
        )
        return pos

    # ---- redistribution ----------------------------------------------------------
    def redistribute_cohort(self, cohort: WindowCohort) -> Optional[CohortRedistribution]:
        """
        Called once ALL engines in this window's cohort have a finalized
        raw_pnl. For each engine's trade: credit that engine back exactly
        what it spent (net zero from its own result), then split its
        raw_pnl three ways to the other three engines.
        """
        if cohort.redistributed:
            return None
        if len(cohort.positions) < len(self.engine_labels):
            return None  # not every engine has even opened a position yet this window
        if not all(p.raw_pnl is not None for p in cohort.positions.values()):
            return None  # not every position is finalized yet

        per_engine_raw_pnl: Dict[str, float] = {}
        balance_delta: Dict[str, float] = {lbl: 0.0 for lbl in self.engine_labels}

        for label, pos in cohort.positions.items():
            per_engine_raw_pnl[label] = pos.raw_pnl
            # 1) make the owning engine whole on its own principal (net
            #    zero effect from its own trade result).
            restore = pos.entry_cost + pos.entry_fee
            balance_delta[label] += restore

            # 2) split this trade's actual P&L three ways to the OTHER
            #    engines -- positive raw_pnl shares out a profit, negative
            #    raw_pnl means each of the others absorbs a third of the loss.
            others = [lbl for lbl in self.engine_labels if lbl != label]
            share = pos.raw_pnl / len(others)
            for other in others:
                balance_delta[other] += share

        # Math sanity check: total dollars moved must equal the sum of
        # what was originally spent (restored) plus the net raw P&L
        # across all 4 trades (since profits/losses net out across the
        # group, not created or destroyed by the redistribution itself).
        total_delta = sum(balance_delta.values())
        total_restored = sum(p.entry_cost + p.entry_fee for p in cohort.positions.values())
        total_raw_pnl = sum(per_engine_raw_pnl.values())
        expected_total = total_restored + total_raw_pnl
        if abs(total_delta - expected_total) > 1e-6:
            self.log.critical(
                "MATH BUG: redistribution total %.6f != expected %.6f (restored=%.6f + raw_pnl=%.6f) "
                "for window %s -- refusing to apply.",
                total_delta, expected_total, total_restored, total_raw_pnl, cohort.window_start,
            )
            raise AssertionError("redistribution math invariant violated")

        for label, delta in balance_delta.items():
            self.balances[label] += delta

        cohort.redistributed = True
        record = CohortRedistribution(
            window_start=cohort.window_start,
            completed_at=time.time(),
            per_engine_raw_pnl=per_engine_raw_pnl,
            per_engine_balance_delta=balance_delta,
        )
        self.cohort_history.append(record)
        self.log.info(
            "REDISTRIBUTE window=%s raw_pnl=%s deltas=%s new_balances=%s",
            cohort.window_start,
            {k: round(v, 2) for k, v in per_engine_raw_pnl.items()},
            {k: round(v, 2) for k, v in balance_delta.items()},
            {k: round(v, 2) for k, v in self.balances.items()},
        )
        return record

    # ---- reporting ----------------------------------------------------------------
    def total_capital(self) -> float:
        return sum(self.balances.values())
