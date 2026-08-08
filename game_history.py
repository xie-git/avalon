import argparse
import json

from chat_store import configured_chat_store


def main() -> None:
    parser = argparse.ArgumentParser(description="Read Avalon's saved game event logs")
    parser.add_argument("--games", action="store_true", help="list saved games")
    parser.add_argument("--room", help="four-letter room code")
    parser.add_argument("--started-at", type=float, help="game start Unix timestamp")
    parser.add_argument("--limit", type=int, default=100000)
    args = parser.parse_args()
    store = configured_chat_store()

    if args.games:
        for row in store.saved_games(limit=args.limit):
            print(
                f"{row['room_code']}  {row['game_started_at']:.3f}  "
                f"{row['started_at']}  {row['event_count']} events"
            )
        return
    if not args.room or args.started_at is None:
        parser.error("use --games or provide both --room and --started-at")
    for row in store.events_for_game(args.room, args.started_at, limit=args.limit):
        payload = json.loads(row["payload_json"])
        print(f"{row['created_at']}  {row['event_type']}  {json.dumps(payload, sort_keys=True)}")


if __name__ == "__main__":
    main()
