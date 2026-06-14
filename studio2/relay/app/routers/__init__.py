"""FastAPI routers for the Studio v2 relay.

Step 1 routers: ``auth`` (login/logout/me), ``tls`` (/ca.crt, /setup,
/api/tls/info), ``status`` (/api/status), ``client_log`` (/api/client-log).
``deps`` carries the shared ``require_session`` dependency + error helpers.
Step 3 adds ``bridge`` and ``chat``.
"""
