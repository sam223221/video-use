"""video-use Studio backend package.

A local FastAPI app that wraps the existing ``video-use`` skill + helpers with an
embedded Claude Agent SDK chat. See ARCHITECTURE.md at the studio/ root for the
full design. This package is the backend; the buildless SPA lives in
``studio/frontend/`` (served as static assets by ``app.main``).
"""

__version__ = "0.1.0"
