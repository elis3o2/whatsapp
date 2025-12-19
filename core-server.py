# main.py
from fastapi import FastAPI, Request, UploadFile
from fastapi.responses import Response, JSONResponse
import threading
import requests
from io import BytesIO
import urllib.parse
from typing import Optional
from fastapi import Body, Query, Path, Form, File, UploadFile
import json


app = FastAPI()

# ----- CONFIG -----
HOST = "127.0.0.1"                            # host destino
SESSIONS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']                      # sesiones identificadoras (orden para round-robin)
SESSIONS_PORT = {'a': 3005, 'b': 3006, 'c': 3007, 'd': 3008, 'e': 3009, 
                'f': 3010, 'g': 3011, 'h': 3012, 'i': 3013, 'j': 3014}
FORWARD_TIMEOUT = 30                          # segundos
HOP_BY_HOP_HEADERS = {
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailers', 'transfer-encoding', 'upgrade'
}
# -------------------

# round-robin state
rr_index = 0
rr_lock = threading.Lock()

def get_next_session_round_robin_index():
    """Devuelve el índice (en la lista SESSIONS) para comenzar la ronda."""
    global rr_index
    with rr_lock:
        idx = rr_index % len(SESSIONS)
        rr_index += 1
        return idx

def ports_list_order_from_index(start_idx: int):
    """Devuelve la lista de puertos en orden circular empezando en start_idx."""
    ordered_sessions = SESSIONS[start_idx:] + SESSIONS[:start_idx]
    return [SESSIONS_PORT[s] for s in ordered_sessions]

def filter_response_headers(headers):
    """Filtra cabeceras hop-by-hop y devuelve dict listo para FastAPI Response."""
    out = {}
    for k, v in headers.items():
        if k.lower() in HOP_BY_HOP_HEADERS:
            continue
        out[k] = v
    return out

def _make_requests_loop_and_forward(method: str, path: str, headers: dict, params: dict, data_bytes: bytes, files_for_requests: dict, start_ports: list, result: dict):
    """
    Intenta realizar la request hacia los puertos en start_ports en orden (failover permitido).
    - Si hay archivos + form_fields: los envía como multipart (requests acepta `data` + `files`).
    - Si sólo body raw: lo envía como bytes.
    - Si una respuesta llega con status < 500 se guarda y se retorna.
    - Si status >= 500 o hay excepción, intenta el siguiente puerto.
    """
    last_error = None

    for port in start_ports:
        try:
            url = f"http://{HOST}:{port}{path}"
            fwd_headers = {k: v for k, v in (headers or {}).items() if k.lower() != 'host'}

            # prepare payloads per-attempt from a copy (no mutación del dict original)
            files_payload = None
            data_param = None

            if files_for_requests:
                ff = files_for_requests.get('__form_fields__')
                form_fields = ff.get('form_fields') if ff else None

                if any(k != '__form_fields__' for k in files_for_requests.keys()):
                    files_payload = {}
                    for fieldname, info in files_for_requests.items():
                        if fieldname == '__form_fields__':
                            continue
                        filename = info.get('filename') or fieldname
                        stream = BytesIO(info.get('content', b''))
                        ct = info.get('content_type', None)
                        files_payload[fieldname] = (filename, stream, ct)

                if form_fields:
                    data_param = form_fields
                else:
                    data_param = None

            else:
                data_param = data_bytes

            resp = requests.request(
                method=method,
                url=url,
                headers=fwd_headers,
                params=params,
                data=data_param,
                files=files_payload,
                timeout=FORWARD_TIMEOUT,
                proxies={"http": None, "https": None} 
            )

            # Si la respuesta tiene status >= 500, consideramos fallo y probamos siguiente puerto
            if resp.status_code >= 500:
                last_error = f"HTTP {resp.status_code} from {url}"
                continue

            # respuesta aceptable: guardarla y salir
            result['status_code'] = resp.status_code
            result['headers'] = dict(resp.headers)
            result['content'] = resp.content
            return
        except Exception as e:
            last_error = str(e)
            continue

    # si llegamos acá, no tuvimos respuesta válida
    result['error'] = last_error or "No response from backends"

def _make_request_single_port(method: str, path: str, headers: dict, params: dict, data_bytes: bytes, files_for_requests: dict, port: int, result: dict):
    """
    Hace la request únicamente al puerto indicado. No realiza failover.
    Guarda respuesta en result o error si ocurrió.
    """
    try:
        url = f"http://{HOST}:{port}{path}"
        fwd_headers = {k: v for k, v in (headers or {}).items() if k.lower() != 'host'}

        files_payload = None
        data_param = None

        if files_for_requests:
            ff = files_for_requests.get('__form_fields__')
            form_fields = ff.get('form_fields') if ff else None

            if any(k != '__form_fields__' for k in files_for_requests.keys()):
                files_payload = {}
                for fieldname, info in files_for_requests.items():
                    if fieldname == '__form_fields__':
                        continue
                    filename = info.get('filename') or fieldname
                    stream = BytesIO(info.get('content', b''))
                    ct = info.get('content_type', None)
                    files_payload[fieldname] = (filename, stream, ct)

            if form_fields:
                data_param = form_fields
            else:
                data_param = None
        else:
            data_param = data_bytes

        resp = requests.request(
            method=method,
            url=url,
            headers=fwd_headers,
            params=params,
            data=data_param,
            files=files_payload,
            timeout=FORWARD_TIMEOUT,
            proxies={"http": None, "https": None} 
        )

        # guardamos lo que venga (incluso 5xx). Caller decidirá si considera error o no.
        result['status_code'] = resp.status_code
        result['headers'] = dict(resp.headers)
        result['content'] = resp.content

    except Exception as e:
        result['error'] = str(e)

# Helper que lanza el thread y espera su terminación (failover allowed)
def run_forward_thread_and_get_response(method: str, path: str, headers: dict, params: dict, data_bytes: bytes, files_for_requests: dict, start_ports: list):
    result = {}
    th = threading.Thread(
        target=_make_requests_loop_and_forward,
        args=(method, path, headers, params, data_bytes, files_for_requests, start_ports, result),
        daemon=True
    )
    th.start()
    th.join()

    if 'error' in result:
        return JSONResponse({"error": "No backend available or all backends failed", "detail": result['error']}, status_code=502)
    else:
        resp_headers = filter_response_headers(result.get('headers', {}))
        return Response(content=result.get('content', b''), status_code=result.get('status_code'), headers=resp_headers)

# Helper que lanza el thread y espera su terminación (single port, no failover)
def run_single_port_thread_and_get_response(method: str, path: str, headers: dict, params: dict, data_bytes: bytes, files_for_requests: dict, port: int):
    result = {}
    th = threading.Thread(
        target=_make_request_single_port,
        args=(method, path, headers, params, data_bytes, files_for_requests, port, result),
        daemon=True
    )
    th.start()
    th.join()

    # If there was an exception contacting the backend -> return 502 with detail
    if 'error' in result:
        return JSONResponse({"error": "Backend connection error", "detail": result['error']}, status_code=502)

    # We return exactly what backend returned (including 5xx). Do not failover.
    resp_headers = filter_response_headers(result.get('headers', {}))
    return Response(content=result.get('content', b''), status_code=result.get('status_code'), headers=resp_headers)

# ------------------- ROUTES -------------------

# POST: enviar-mensaje (NO recibe files: reenviamos el body tal cual). POST still uses round-robin + failover.
@app.post("/enviar-mensaje")
async def enviar_mensaje(numero: str = Body(..., description="Número destino"),
                         texto: str = Body(..., description="Texto a enviar"),
                         request: Request = None):
    body = await request.body()
    headers = dict(request.headers)
    params = dict(request.query_params)

    start_idx = get_next_session_round_robin_index()
    start_ports = ports_list_order_from_index(start_idx)

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=headers,
        params=params,
        data_bytes=body,
        files_for_requests=None,
        start_ports=start_ports,
    )

# POST: enviar-archivo (espera campo 'archivo' o multipart form-data). POST still uses round-robin + failover.
@app.post("/enviar-archivo")
async def enviar_archivo(numero: str = Form(..., description="Número destino"),
                         texto: Optional[str] = Form(None, description="Texto (opcional)"),
                         archivo: Optional[UploadFile] = File(None, description="Archivo (campo 'archivo')"),
                         request: Request = None):
    form = await request.form()
    files_payload = {}
    for k, v in form.multi_items():
        if isinstance(v, UploadFile):
            content = await v.read()
            files_payload[k] = {"filename": v.filename, "content": content, "content_type": v.content_type}

    form_fields = {}
    for k, v in form.items():
        if not isinstance(v, UploadFile):
            form_fields[k] = v

    if form_fields and not files_payload:
        data_bytes = urllib.parse.urlencode(form_fields).encode('utf-8')
    elif form_fields and files_payload:
        data_bytes = None
        files_payload['__form_fields__'] = {"form_fields": form_fields}
    else:
        data_bytes = await request.body()

    headers = dict(request.headers)
    params = dict(request.query_params)

    start_idx = get_next_session_round_robin_index()
    start_ports = ports_list_order_from_index(start_idx)

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=headers,
        params=params,
        data_bytes=data_bytes,
        files_for_requests=files_payload,
        start_ports=start_ports
    )

@app.post("/enviar-ubicacion")
async def enviar_ubicacion(lat: float = Body(..., description="Latitud"),
                           lon: float = Body(..., description="Longitud"),
                           numero: str = Body(..., description="Número destino"),
                           request: Request = None):
    body = await request.body()
    headers = dict(request.headers)
    params = dict(request.query_params)

    start_idx = get_next_session_round_robin_index()
    start_ports = ports_list_order_from_index(start_idx)

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=headers,
        params=params,
        data_bytes=body,
        files_for_requests=None,
        start_ports=start_ports
    )


@app.post("/esperar")
async def esperar(numero: str = Body(..., description="Número destino"),
                  texto: str = Body(..., description="Texto"),
                  request: Request = None):
    body = await request.body()
    headers = dict(request.headers)
    params = dict(request.query_params)

    start_idx = get_next_session_round_robin_index()
    start_ports = ports_list_order_from_index(start_idx)

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,
        headers=headers,
        params=params,
        data_bytes=body,
        files_for_requests=None,
        start_ports=start_ports
    )

@app.post("/start_flow")
async def start_flow(
    flowName: str = Form(..., description="Nombre del flow"),
    numero: str = Form(..., description="Número destino"),
    endpoint: str = Form(..., description="Endpoint callback"),
    request: Request = None
):
    # reconstruimos el form para reenviar
    form = await request.form()

    form_fields = {}
    for k, v in form.items():
        if not isinstance(v, UploadFile):
            form_fields[k] = v

    # no hay archivos, solo form-data
    data_bytes = urllib.parse.urlencode(form_fields).encode("utf-8")

    headers = dict(request.headers)
    params = dict(request.query_params)

    start_idx = get_next_session_round_robin_index()
    start_ports = ports_list_order_from_index(start_idx)

    return run_forward_thread_and_get_response(
        method="POST",
        path=request.url.path,     # /start_flow
        headers=headers,
        params=params,
        data_bytes=data_bytes,
        files_for_requests=None,
        start_ports=start_ports
    )



# GET endpoints: require session param -> use single port (no failover)
def _extract_session_param_or_400(request: Request):
    """Extrae session del query param y valida; si falta o es inválido devuelve JSONResponse (400)."""
    session = request.query_params.get('session')
    if not session:
        return JSONResponse({"error": "Missing 'session' query parameter"}, status_code=400)
    
    s = session
    if s not in SESSIONS:
        return JSONResponse({"error": f"Unknown session {s}"}, status_code=400)
    port = SESSIONS_PORT[s]
    return port



@app.get("/respuesta")
async def respuesta(session: str = Path(..., description="Session id"),
                    numero: Optional[str] = Query(None, description="Número"),
                    texto: Optional[str] = Query(None, description="Texto"),
                    request: Request = None):

    port_or_resp = _extract_session_param_or_400(request)
    if isinstance(port_or_resp, JSONResponse):
        return port_or_resp
    port = port_or_resp

    headers = dict(request.headers)
    params = dict(request.query_params)

    # call single port, no failover
    return run_single_port_thread_and_get_response(
        method="GET",
        path=request.url.path,
        headers=headers,
        params=params,
        data_bytes=None,
        files_for_requests=None,
        port=port
    )

@app.get("/estado")
async def estado(request: Request):
    port_or_resp = _extract_session_param_or_400(request)
    if isinstance(port_or_resp, JSONResponse):
        return port_or_resp
    port = port_or_resp

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

@app.get("/get_mensajes")
async def get_mensajes(numero: str, request: Request):
    port_or_resp = _extract_session_param_or_400(request)
    if isinstance(port_or_resp, JSONResponse):
        return port_or_resp
    port = port_or_resp

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


@app.get("/qr")
async def get_qr(request: Request):
    port_or_resp = _extract_session_param_or_400(request)
    if isinstance(port_or_resp, JSONResponse):
        return port_or_resp
    port = port_or_resp

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


@app.get("/status")
async def get_status(request: Request):
    port_or_resp = _extract_session_param_or_400(request)
    if isinstance(port_or_resp, JSONResponse):
        return port_or_resp
    port = port_or_resp

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


@app.get("/status-all")
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
                "state": "error"
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
            "state": state
        })

    return results



# Debug endpoint
@app.get("/_debug/rr_state")
async def debug_rr():
    with rr_lock:
        return {"rr_index": rr_index, "sessions": SESSIONS, "session_to_port": SESSIONS_PORT}

@app.get("/")
async def root():
    return {"ok": True}
