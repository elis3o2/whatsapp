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
