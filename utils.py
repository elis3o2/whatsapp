import threading
import requests
from typing import Optional
from fastapi.responses import Response, JSONResponse
from responses import COMMON_ERROR_EXAMPLES

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

# round-robin state
rr_index = 0
rr_lock = threading.Lock()


def get_next_session_round_robin_index():
    global rr_index
    with rr_lock:
        idx = rr_index % len(SESSIONS)
        rr_index += 1
        return idx


def build_ports_priority_queue(preferred_session: Optional[str]):
    """
    Devuelve la cola round-robin rotada para comenzar en preferred_session.
    Si no hay sesión válida → round-robin normal.
    """

    # cola base según round-robin
    start_idx = get_next_session_round_robin_index()
    base_sessions = SESSIONS[start_idx:] + SESSIONS[:start_idx]

    # si no hay sesión válida → normal
    if not preferred_session or preferred_session not in base_sessions:
        return [SESSIONS_PORT[s] for s in base_sessions]

    # encontrar índice dentro de la cola actual
    i = base_sessions.index(preferred_session)

    # rotar la cola
    rotated = base_sessions[i:] + base_sessions[:i]

    return [SESSIONS_PORT[s] for s in rotated]



def filter_response_headers(headers: dict):
    out = {}
    for k, v in headers.items():
        if k.lower() in HOP_BY_HOP_HEADERS:
            continue
        out[k] = v
    return out


def _make_requests_loop_and_forward(method: str, path: str, headers: dict, params: dict,
                                    data_bytes: Optional[bytes], files_for_requests: Optional[dict],
                                    start_ports: list, result: dict):
    """
    Reintentos en el orden de start_ports (failover). Guarda la primera respuesta con status < 500.
    """
    last_error = None

    for port in start_ports:
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

            if resp.status_code >= 500:
                last_error = f"HTTP {resp.status_code} from {url}"
                continue

            result['status_code'] = resp.status_code
            result['headers'] = dict(resp.headers)
            result['content'] = resp.content
            return
        except Exception as e:
            last_error = str(e)
            continue

    # si llegamos acá, no tuvimos respuesta válida
    result['error'] = last_error or "No response from backends"


def _make_request_single_port(method: str, path: str, headers: dict, params: dict,
                              data_bytes: Optional[bytes], files_for_requests: Optional[dict],
                              port: int, result: dict):
    """
    Reenvía sólo al puerto indicado (no failover). Guarda la respuesta aunque sea 5xx.
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

        result['status_code'] = resp.status_code
        result['headers'] = dict(resp.headers)
        result['content'] = resp.content

    except Exception as e:
        result['error'] = str(e)


def run_forward_thread_and_get_response(method: str, path: str, headers: dict, params: dict,
                                        data_bytes: Optional[bytes], files_for_requests: Optional[dict],
                                        start_ports: list):
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


def run_single_port_thread_and_get_response(method: str, path: str, headers: dict, params: dict,
                                            data_bytes: Optional[bytes], files_for_requests: Optional[dict],
                                            port: int):
    result = {}
    th = threading.Thread(
        target=_make_request_single_port,
        args=(method, path, headers, params, data_bytes, files_for_requests, port, result),
        daemon=True
    )
    th.start()
    th.join()

    if 'error' in result:
        print("ERROR EN REQUEST:", result)
        return JSONResponse(COMMON_ERROR_EXAMPLES["sesion_invalida"]['value'], status_code=502)

    resp_headers = filter_response_headers(result.get('headers', {}))
    return Response(content=result.get('content', b''), status_code=result.get('status_code'), headers=resp_headers)

