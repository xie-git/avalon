import argparse
import json
from collections import Counter

from chat_store import configured_chat_store


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Read Avalon's privacy-bounded product analytics"
    )
    parser.add_argument("--game-id")
    parser.add_argument("--party-id")
    parser.add_argument("--limit", type=int, default=10000)
    parser.add_argument(
        "--summary", action="store_true", help="show event counts instead of raw events"
    )
    args = parser.parse_args()
    rows = configured_chat_store().product_events(
        game_id=args.game_id,
        party_id=args.party_id,
        limit=args.limit,
    )
    if args.summary:
        counts = Counter(row["event_type"] for row in rows)
        for event_type, count in counts.most_common():
            print(f"{count:6d}  {event_type}")
        return
    for row in rows:
        payload = json.loads(row["payload_json"])
        context = " ".join(
            value
            for value in (
                row["room_code"] or "",
                row["game_id"] or "",
                row["actor_type"],
            )
            if value
        )
        print(
            f"{row['created_at']}  {context}  {row['event_type']}  "
            f"{json.dumps(payload, sort_keys=True)}"
        )


if __name__ == "__main__":
    main()
