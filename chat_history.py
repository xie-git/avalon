import argparse
from datetime import date

from chat_store import configured_chat_store


def main() -> None:
    parser = argparse.ArgumentParser(description="Read Avalon's saved chat history")
    selection = parser.add_mutually_exclusive_group(required=True)
    selection.add_argument(
        "--dates", action="store_true", help="list dates that contain messages"
    )
    selection.add_argument(
        "--date", metavar="YYYY-MM-DD", help="show messages from one UTC date"
    )
    parser.add_argument("--room", help="optionally filter by four-letter room code")
    parser.add_argument("--limit", type=int, default=5000, help="maximum rows to show")
    args = parser.parse_args()

    store = configured_chat_store()
    if args.dates:
        for chat_date, count in store.available_dates():
            print(f"{chat_date}  {count} message{'s' if count != 1 else ''}")
        return

    try:
        selected_date = date.fromisoformat(args.date)
    except ValueError as error:
        parser.error(str(error))
    rows = store.messages_for_date(
        selected_date, room_code=args.room, limit=args.limit
    )
    for row in rows:
        print(
            f"{row['created_at']}  [{row['room_code']}] "
            f"{row['player_name']}: {row['message']}"
        )


if __name__ == "__main__":
    main()
