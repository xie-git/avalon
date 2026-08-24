import argparse
import html
import os
import shutil
from pathlib import Path

from chat_store import configured_chat_store


def main() -> None:
    parser = argparse.ArgumentParser(
        description="List Avalon's private selfie archive"
    )
    parser.add_argument("--limit", type=int, default=1000, help="maximum rows to show")
    parser.add_argument("--room", help="only include one room code")
    parser.add_argument(
        "--export",
        metavar="DIRECTORY",
        help="copy a private, browsable HTML gallery to this explicit directory",
    )
    args = parser.parse_args()
    store = configured_chat_store()
    archive_dir = Path(
        os.environ.get(
            "SELFIE_ARCHIVE_DIR", str(store.path.parent / "private" / "selfies")
        )
    )

    rows = [
        row for row in store.saved_selfies(limit=args.limit)
        if not args.room or row["room_code"] == args.room.upper()
    ]
    for row in rows:
        print(
            f"{row['created_at']}  [{row['room_code']}] {row['player_name']}  "
            f"{row['byte_count']} bytes  {archive_dir / row['storage_name']}"
        )

    if args.export:
        export_dir = Path(args.export).expanduser().resolve()
        export_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        cards = []
        for index, row in enumerate(rows, start=1):
            source = archive_dir / row["storage_name"]
            if not source.is_file():
                continue
            safe_time = row["created_at"].replace(":", "-")
            filename = f"{safe_time}_{row['room_code']}_{index:04d}.jpg"
            destination = export_dir / filename
            shutil.copyfile(source, destination)
            os.chmod(destination, 0o600)
            cards.append(
                "<figure>"
                f'<img src="{html.escape(filename)}" alt="">'
                f"<figcaption><strong>{html.escape(row['player_name'])}</strong> · "
                f"{html.escape(row['room_code'])}<br>{html.escape(row['created_at'])}</figcaption>"
                "</figure>"
            )
        document = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Avalon selfie archive</title><style>
body{font:16px system-ui;background:#111;color:#eee;margin:2rem}h1{color:#e4c66d}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:1rem}
figure{margin:0;background:#201c18;padding:.75rem;border-radius:12px}img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px}
figcaption{padding-top:.55rem;line-height:1.35;color:#c9c3b8}strong{color:#fff}</style></head>
<body><h1>Avalon selfie archive</h1><main>""" + "".join(cards) + "</main></body></html>"
        index_path = export_dir / "index.html"
        index_path.write_text(document, encoding="utf-8")
        os.chmod(index_path, 0o600)
        print(f"Exported {len(cards)} selfies to {index_path}")


if __name__ == "__main__":
    main()
