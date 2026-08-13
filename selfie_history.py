import argparse
import os
from pathlib import Path

from chat_store import configured_chat_store


def main() -> None:
    parser = argparse.ArgumentParser(
        description="List Avalon's private selfie archive"
    )
    parser.add_argument("--limit", type=int, default=1000, help="maximum rows to show")
    args = parser.parse_args()
    store = configured_chat_store()
    archive_dir = Path(
        os.environ.get(
            "SELFIE_ARCHIVE_DIR", str(store.path.parent / "private" / "selfies")
        )
    )

    for row in store.saved_selfies(limit=args.limit):
        print(
            f"{row['created_at']}  [{row['room_code']}] {row['player_name']}  "
            f"{row['byte_count']} bytes  {archive_dir / row['storage_name']}"
        )


if __name__ == "__main__":
    main()
