# main.py (revisado para que la documentación OpenAPI sea consistente)
from fastapi import FastAPI, Request, UploadFile, File, Form, Body, Query, HTTPException
from fastapi.responses import Response, JSONResponse
from typing import Optional, Dict, Any
from io import BytesIO
import urllib.parse
import json
from models import (CommonSuccessModel, ErrorModel, EnviarMensajeModel, EnviarUbicacionModel,
                    EnviarArchivo, EnviarEsperarModel, StartFlowModel, MensajeResponse, )
from responses import COMMON_ERROR_EXAMPLES, COMMON_RESPONSES_POST, COMMON_RESPONSES_SESSION, RESPONSES_STATUS
from utils import (run_single_port_thread_and_get_response, run_forward_thread_and_get_response,
                    _make_request_single_port, build_ports_priority_queue)


app = FastAPI(
    title="Load Balancer Proxy API",
    description="Proxy / load-balancer que reenvía requests a múltiples backends (round-robin + failover).",
    version="1.0.0"
)


# ----- CONFIG -----
HOST = "127.0.0.1"
SESSIONS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
SESSIONS_PORT = {
    'a': 3021, 'b': 3022, 'c': 3023, 'd': 3024, 'e': 3025,
    'f': 3026, 'g': 3027, 'h': 3028, 'i': 3029, 'j': 3030
}
FORWARD_TIMEOUT = 30
HOP_BY_HOP_HEADERS = {
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade'
}

# ------------------- ROUTES -------------------

@app.post(
    "/enviar-mensaje",
    response_model=CommonSuccessModel,
    response_description="Resultado del envío del mensaje",
    tags=["mensajeria"],
    responses=COMMON_RESPONSES_POST
)
async def enviar_mensaje(payload: EnviarMensajeModel = Body(...), request: Request = None):
    # tu código existente (sin cambios)
    body = await request.body()
    headers = dict(request.headers)
    params = dict(request.query_params)

    preferred_session = payload.session or params.get("session")

    start_ports = build_ports_priority_queue(preferred_session)

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=headers,
        params=params,
        data_bytes=body,
        files_for_requests=None,
        start_ports=start_ports,
    )


@app.post("/enviar-archivo")
async def enviar_archivo(request: Request):

    headers = dict(request.headers)
    params = dict(request.query_params)

    body = await request.body()
    preferred_session = params.get("session")

    start_ports = build_ports_priority_queue(preferred_session)

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=headers,
        params=params,
        data_bytes=body,
        files_for_requests=None,
        start_ports=start_ports
    )


@app.post(
    "/enviar-ubicacion",
    response_model=CommonSuccessModel,
    tags=["mensajeria"],
    responses=COMMON_RESPONSES_POST
)
async def enviar_ubicacion(payload: EnviarUbicacionModel = Body(...), request: Request = None):
    body = await request.body()
    headers = dict(request.headers)
    params = dict(request.query_params)

    preferred_session = getattr(payload, "session", None) or params.get("session")

    start_ports = build_ports_priority_queue(preferred_session)

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=headers,
        params=params,
        data_bytes=body,
        files_for_requests=None,
        start_ports=start_ports
    )


@app.post(
    "/esperar",
    response_model=CommonSuccessModel,
    tags=["mensajeria"],
    responses=COMMON_RESPONSES_POST
)
async def esperar(payload: EnviarMensajeModel = Body(...), request: Request = None):
    body = await request.body()
    headers = dict(request.headers)
    params = dict(request.query_params)

    preferred_session = session or params.get("session")

    start_ports = build_ports_priority_queue(preferred_session)

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=headers,
        params=params,
        data_bytes=body,
        files_for_requests=None,
        start_ports=start_ports
    )


@app.post(
    "/start_flow",
    response_model=CommonSuccessModel,
    tags=["flows"],
    responses=COMMON_RESPONSES_POST
)
async def start_flow(payload: StartFlowModel = Body(...), request: Request = None):
    body = await request.body()
    headers = dict(request.headers)
    params = dict(request.query_params)

    preferred_session = getattr(payload, "session", None) or params.get("session")

    start_ports = build_ports_priority_queue(preferred_session)

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=headers,
        params=params,
        data_bytes=body,
        files_for_requests=None,
        start_ports=start_ports
    )


# Helper: valida session query param y devuelve puerto o lanza HTTPException 400
def _get_port_from_session_param(qs: Dict[str, Any]):
    session = qs.get('session')
    if not session:
        raise HTTPException(status_code=400, detail=COMMON_ERROR_EXAMPLES['faltan_datos']['value'])
    if session not in SESSIONS:
        raise HTTPException(status_code=400, detail=COMMON_ERROR_EXAMPLES['sesion_invalida']['value'])
    return SESSIONS_PORT[session]


@app.get("/respuesta", tags=["consultas"])
async def respuesta(session: str = Query(..., description="Session id"),
                    numero: Optional[str] = Query(None, description="Número"),
                    texto: Optional[str] = Query(None, description="Texto"),
                    request: Request = None):
    """
    GET que requiere query param 'session'. Reenvío directo al puerto asociado (no failover).
    """
    try:
        port = _get_port_from_session_param(dict(request.query_params))
    except HTTPException as e:
        return JSONResponse({"error": e.detail}, status_code=e.status_code)

    headers = dict(request.headers)
    params = dict(request.query_params)

    return run_single_port_thread_and_get_response(
        method="GET",
        path=request.url.path,
        headers=headers,
        params=params,
        data_bytes=None,
        files_for_requests=None,
        port=port
    )



@app.get(
        "/estado/{session}/{id}/{numero}",
        tags=["consultas"],
        response_model=CommonSuccessModel,
        responses=COMMON_RESPONSES_SESSION
)
async def estado(session: str, id: str , numero: str, request: Request = None):
    try:
        port = _get_port_from_session_param({"session": session})
    except HTTPException as e:
        return JSONResponse(e.detail, status_code=e.status_code)

    headers = dict(request.headers)

    path = f"/estado/{id}/{numero}"

    return run_single_port_thread_and_get_response(
        "GET",
        path,
        headers,
        None,
        None,
        None,
        port
    )

@app.get("/get_mensajes", tags=["consultas"])
async def get_mensajes(numero: str = Query(..., description="Número"), session: str = Query(..., description="Session id"), request: Request = None):
    try:
        port = _get_port_from_session_param(dict(request.query_params))
    except HTTPException as e:
        return JSONResponse({"error": e.detail}, status_code=e.status_code)

    headers = dict(request.headers)
    params = dict(request.query_params)
    return run_single_port_thread_and_get_response("GET", request.url.path, headers, params, None, None, port)


@app.get("/qr/{session}", tags=["consultas"])
async def get_qr(session: str, request: Request = None):
    try:
        port = _get_port_from_session_param({"session": session})
    except HTTPException as e:
        return JSONResponse(e.detail, status_code=e.status_code)

    headers = dict(request.headers)

    path = "/qr"

    return run_single_port_thread_and_get_response(
        "GET",
        path,
        headers,
        None,
        None,
        None,
        port
    )

@app.get("/status/{session}", tags=["consultas"])
async def get_status(session: str, request: Request = None):
    try:
        port = _get_port_from_session_param({"session": session})
    except HTTPException as e:
        return JSONResponse(e.detail, status_code=e.status_code)

    headers = dict(request.headers)
    path = "/status"
    return run_single_port_thread_and_get_response(
        "GET",
        path,
        headers,
        None,
        None,
        None,
        port
    )


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
            result=result
        )

        if "error" in result:
            results.append({
                "session": session,
                "state": "error",
                "port": port
            })
            continue

        try:
            raw = result.get("content", b"")
            data = json.loads(raw.decode("utf-8"))
            state = data.get("state", "unknown")
        except Exception:
            state = "unknown"

        results.append({
            "session": session,
            "state": state,
            "port": port
        })

    return results


@app.get("/_debug/rr_state", tags=["debug"])
async def debug_rr():
    with rr_lock:
        return {"rr_index": rr_index, "sessions": SESSIONS, "session_to_port": SESSIONS_PORT}


@app.get("/", tags=["health"])
async def root():
    return {"ok": True}
