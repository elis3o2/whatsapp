import json
from typing import Optional, Dict, Any

from fastapi import FastAPI, Request, Body, Query, HTTPException
from fastapi.responses import JSONResponse

from config import SESSIONS, SESSIONS_PORT
from models import (
    CommonSuccessModel, EnviarMensajeModel, EnviarUbicacionModel,
    EnviarArchivo, EnviarEsperarModel, StartFlowModel,
)
from responses import COMMON_ERROR_EXAMPLES, COMMON_RESPONSES_POST, COMMON_RESPONSES_SESSION, RESPONSES_STATUS
from utils import (
    run_single_port_thread_and_get_response,
    run_forward_thread_and_get_response,
    _make_request_single_port,
    build_ports_priority_queue,
    rr_lock, rr_index,
)


app = FastAPI(
    title="Load Balancer Proxy API",
    description="Proxy / load-balancer que reenvía requests a múltiples backends (round-robin + failover).",
    version="1.0.0",
)


# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────

def _get_port_from_session_param(qs: Dict[str, Any]) -> int:
    """Valida el query param 'session' y devuelve el puerto asociado."""
    session = qs.get('session')
    if not session:
        raise HTTPException(status_code=400, detail=COMMON_ERROR_EXAMPLES['faltan_datos']['value'])
    if session not in SESSIONS:
        raise HTTPException(status_code=400, detail=COMMON_ERROR_EXAMPLES['sesion_invalida']['value'])
    return SESSIONS_PORT[session]


async def _read_request(request: Request) -> tuple[bytes, dict, dict]:
    """Extrae body, headers y query params de una Request de FastAPI."""
    body = await request.body()
    headers = dict(request.headers)
    params = dict(request.query_params)
    return body, headers, params


# ──────────────────────────────────────────────
# Mensajería
# ──────────────────────────────────────────────

@app.post(
    "/enviar-mensaje",
    response_model=CommonSuccessModel,
    response_description="Resultado del envío del mensaje",
    tags=["mensajeria"],
    responses=COMMON_RESPONSES_POST,
)
async def enviar_mensaje(payload: EnviarMensajeModel = Body(...), request: Request = None):
    body, headers, params = await _read_request(request)
    preferred_session = payload.session or params.get("session")
    start_ports = build_ports_priority_queue(preferred_session)
    return run_forward_thread_and_get_response("POST", request.url.path, headers, params, body, None, start_ports)


@app.post("/enviar-archivo", tags=["mensajeria"])
async def enviar_archivo(request: Request):
    body, headers, params = await _read_request(request)
    # /enviar-archivo recibe multipart; la sesión sólo viene por query param
    preferred_session = params.get("session")
    start_ports = build_ports_priority_queue(preferred_session)
    return run_forward_thread_and_get_response("POST", request.url.path, headers, params, body, None, start_ports)


@app.post(
    "/enviar-ubicacion",
    response_model=CommonSuccessModel,
    tags=["mensajeria"],
    responses=COMMON_RESPONSES_POST,
)
async def enviar_ubicacion(payload: EnviarUbicacionModel = Body(...), request: Request = None):
    body, headers, params = await _read_request(request)
    preferred_session = getattr(payload, "session", None) or params.get("session")
    start_ports = build_ports_priority_queue(preferred_session)
    return run_forward_thread_and_get_response("POST", request.url.path, headers, params, body, None, start_ports)


@app.post(
    "/esperar",
    response_model=CommonSuccessModel,
    tags=["mensajeria"],
    responses=COMMON_RESPONSES_POST,
)
async def esperar(payload: EnviarEsperarModel = Body(...), request: Request = None):
    body, headers, params = await _read_request(request)
    # FIX: era `session` (NameError) — debe ser `payload.session`
    preferred_session = payload.session or params.get("session")
    start_ports = build_ports_priority_queue(preferred_session)
    return run_forward_thread_and_get_response("POST", request.url.path, headers, params, body, None, start_ports)


# ──────────────────────────────────────────────
# Flows
# ──────────────────────────────────────────────

@app.post(
    "/start_flow",
    response_model=CommonSuccessModel,
    tags=["flows"],
    responses=COMMON_RESPONSES_POST,
)
async def start_flow(payload: StartFlowModel = Body(...), request: Request = None):
    body, headers, params = await _read_request(request)
    preferred_session = getattr(payload, "session", None) or params.get("session")
    start_ports = build_ports_priority_queue(preferred_session)
    return run_forward_thread_and_get_response("POST", request.url.path, headers, params, body, None, start_ports)


# ──────────────────────────────────────────────
# Consultas (single-port, sin failover)
# ──────────────────────────────────────────────

@app.get("/respuesta", tags=["consultas"])
async def respuesta(
    session: str = Query(..., description="Session id"),
    numero: Optional[str] = Query(None),
    texto: Optional[str] = Query(None),
    request: Request = None,
):
    try:
        port = _get_port_from_session_param(dict(request.query_params))
    except HTTPException as e:
        return JSONResponse({"error": e.detail}, status_code=e.status_code)

    _, headers, params = await _read_request(request)
    return run_single_port_thread_and_get_response("GET", request.url.path, headers, params, None, None, port)


@app.get(
    "/estado/{session}/{id}/{numero}",
    tags=["consultas"],
    response_model=CommonSuccessModel,
    responses=COMMON_RESPONSES_SESSION,
)
async def estado(session: str, id: str, numero: str, request: Request = None):
    try:
        port = _get_port_from_session_param({"session": session})
    except HTTPException as e:
        return JSONResponse(e.detail, status_code=e.status_code)

    headers = dict(request.headers)
    return run_single_port_thread_and_get_response("GET", f"/estado/{id}/{numero}", headers, None, None, None, port)


@app.get("/get_mensajes", tags=["consultas"])
async def get_mensajes(
    numero: str = Query(...),
    session: str = Query(...),
    request: Request = None,
):
    try:
        port = _get_port_from_session_param(dict(request.query_params))
    except HTTPException as e:
        return JSONResponse({"error": e.detail}, status_code=e.status_code)

    _, headers, params = await _read_request(request)
    return run_single_port_thread_and_get_response("GET", request.url.path, headers, params, None, None, port)


@app.get("/qr/{session}", tags=["consultas"])
async def get_qr(session: str, request: Request = None):
    try:
        port = _get_port_from_session_param({"session": session})
    except HTTPException as e:
        return JSONResponse(e.detail, status_code=e.status_code)

    headers = dict(request.headers)
    return run_single_port_thread_and_get_response("GET", "/qr", headers, None, None, None, port)


@app.get("/status/{session}", tags=["consultas"])
async def get_status(session: str, request: Request = None):
    try:
        port = _get_port_from_session_param({"session": session})
    except HTTPException as e:
        return JSONResponse(e.detail, status_code=e.status_code)

    headers = dict(request.headers)
    return run_single_port_thread_and_get_response("GET", "/status", headers, None, None, None, port)


# ──────────────────────────────────────────────
# Admin
# ──────────────────────────────────────────────

@app.get("/status-all", tags=["admin"], responses=RESPONSES_STATUS)
async def status_all():
    results = []
    for session in SESSIONS:
        port = SESSIONS_PORT[session]
        result = {}

        _make_request_single_port(
            method="GET",
            path="/status",
            headers={},
            params={"session": session},
            data_bytes=None,
            files_for_requests=None,
            port=port,
            result=result,
        )

        if "error" in result:
            results.append({"session": session, "state": "error", "port": port})
            continue

        try:
            data = json.loads(result.get("content", b"").decode("utf-8"))
            state = data.get("state", "unknown")
        except Exception:
            state = "unknown"

        results.append({"session": session, "state": state, "port": port})

    return results


# ──────────────────────────────────────────────
# Debug / Health
# ──────────────────────────────────────────────

@app.get("/_debug/rr_state", tags=["debug"])
async def debug_rr():
    # FIX: importa rr_lock y rr_index desde utils en lugar de referenciarlos localmente
    with rr_lock:
        return {
            "rr_index": rr_index,
            "sessions": SESSIONS,
            "session_to_port": SESSIONS_PORT,
        }


@app.get("/", tags=["health"])
async def root():
    return {"ok": True}