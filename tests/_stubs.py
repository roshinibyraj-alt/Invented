"""No-network test setup: stub out httpx before anything imports polymarket_client, so tests
never touch the real network."""
import sys, types

if 'httpx' not in sys.modules:
    httpx_stub = types.ModuleType('httpx')
    class _FailClient:
        def __init__(self, *a, **kw): pass
        async def get(self, *a, **kw): raise RuntimeError("network disabled in tests")
        async def aclose(self): pass
    httpx_stub.AsyncClient = _FailClient
    sys.modules['httpx'] = httpx_stub

if 'fastapi' not in sys.modules:
    fastapi_stub = types.ModuleType('fastapi')
    class _FastAPI:
        def __init__(self, *a, **kw): pass
        def get(self, *a, **kw):
            def deco(f): return f
            return deco
        def mount(self, *a, **kw): pass
    fastapi_stub.FastAPI = _FastAPI
    responses_mod = types.ModuleType('fastapi.responses')
    class _FileResponse:
        def __init__(self, *a, **kw): pass
    responses_mod.FileResponse = _FileResponse
    staticfiles_mod = types.ModuleType('fastapi.staticfiles')
    class _StaticFiles:
        def __init__(self, *a, **kw): pass
    staticfiles_mod.StaticFiles = _StaticFiles
    sys.modules['fastapi'] = fastapi_stub
    sys.modules['fastapi.responses'] = responses_mod
    sys.modules['fastapi.staticfiles'] = staticfiles_mod
