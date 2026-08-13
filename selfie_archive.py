import hashlib
import os
import threading
import uuid
from pathlib import Path


class SelfieArchive:
    """Content-addressed private storage for already-compressed JPEG selfies."""

    def __init__(self, root: str):
        self.root = Path(root)
        self._lock = threading.Lock()

    def save(self, jpeg: bytes) -> tuple[str, str, int]:
        digest = hashlib.sha256(jpeg).hexdigest()
        storage_name = f"{digest}.jpg"
        destination = self.root / storage_name
        with self._lock:
            self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(self.root, 0o700)
            if not destination.exists():
                temporary = self.root / f".{digest}.{uuid.uuid4().hex}.tmp"
                try:
                    with temporary.open("xb") as handle:
                        os.chmod(temporary, 0o600)
                        handle.write(jpeg)
                        handle.flush()
                        os.fsync(handle.fileno())
                    os.replace(temporary, destination)
                    os.chmod(destination, 0o600)
                finally:
                    temporary.unlink(missing_ok=True)
        return digest, storage_name, len(jpeg)
