FROM python:3.12.13-slim-bookworm@sha256:4766d8b510c428e595d74b9cc5bbb2fae8e26316fffb4adc89908d79aacd58a2

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=5001

WORKDIR /app

RUN groupadd --system --gid 10001 avalon \
    && useradd --system --uid 10001 --gid avalon --home-dir /nonexistent --shell /usr/sbin/nologin avalon \
    && install -d -o avalon -g avalon /data

COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt

COPY --chown=avalon:avalon server.py game_logic.py chat_store.py selfie_archive.py chat_history.py game_history.py selfie_history.py analytics_history.py ./
COPY --chown=avalon:avalon templates ./templates
COPY --chown=avalon:avalon static ./static

USER 10001:10001
EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5001/healthz', timeout=2)"]

CMD ["gunicorn", "--worker-class", "gthread", "--workers", "1", "--threads", "120", "--bind", "0.0.0.0:5001", "--error-logfile", "-", "server:app"]
