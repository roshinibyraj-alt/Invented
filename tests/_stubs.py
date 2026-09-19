"""Lets the tests run without httpx/network: stubs httpx only if it isn't installed."""
import sys, types
try:
    import httpx  # noqa: F401
except ImportError:
    m = types.ModuleType("httpx")

    class AsyncClient:
        def __init__(self, *a, **k): pass
        async def aclose(self): pass

    m.AsyncClient = AsyncClient
    sys.modules["httpx"] = m
