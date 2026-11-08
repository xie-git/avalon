"""Authored voice script for the Court Narrator.

Every line here is pre-rendered to audio by ``tools/voice/generate.py`` and
shipped as static files; nothing is synthesised while a game is running.

Two families of clips exist:

* ``EVENT_CUES`` are spoken by the shared display (and optionally a phone) at
  fixed moments of the game.  Each cue has several takes; clients choose one
  without repeating the previous take.
* ``NARRATOR_PREMISES``, ``NARRATOR_DELIVERIES`` and ``NARRATOR_FOLLOWUPS`` are
  spoken versions of the text Court Narrator in ``narrator.py``.  Recorded
  audio cannot pronounce player names, so the spoken premise is written
  name-free while the chat copy keeps its names.

Clip ids are stable: ``e.<cue>.<take>``, ``n<trigger>``, ``d<delivery>`` and
``n<trigger>f<followup>``.  Changing text only requires re-running the
generator; changing ids also requires updating the clients.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Event cues (display-driven moments)
# ---------------------------------------------------------------------------
EVENT_CUES: dict[str, tuple[str, ...]] = {
    # Lobby -----------------------------------------------------------------
    "lobby.welcome": (
        "Welcome, welcome, to the Round Table! Scan the code, pick a name, and try to look trustworthy.",
        "Ah, guests! Do come in. Phones out, room code in, and leave your honesty at the door.",
        "Gather round, lords and ladies. Tonight, someone at this table will lie to your face. Splendid!",
        "The hall is open! Join on your phones. The betrayal is free, and so are the snacks, presumably.",
    ),
    "lobby.join": (
        "Another soul enters the hall.",
        "Ooh, a new arrival. They look innocent. That's always a bad sign.",
        "Welcome, brave fool!",
        "A fresh face! Let's see how long it stays fresh.",
        "Someone new has joined. Hide the silverware.",
        "Another knight arrives, armed with a phone and questionable judgement.",
        "Hark! A newcomer! Everyone pretend you're nice.",
        "Welcome to Camelot. Please mind the daggers.",
        "Behold, yet another future suspect.",
        "And in walks trouble. Lovely to have you.",
    ),
    "lobby.enough": (
        "Six players! We have enough for a proper conspiracy.",
        "That's a full fellowship. The treachery may now commence whenever the host is ready.",
        "Enough knights at last. Somebody press start before anyone gets cold feet.",
    ),
    "lobby.all_ready": (
        "Everyone is ready. Host, the kingdom awaits your finger.",
        "All hands raised! Well, all phones. Start the game, my liege.",
        "The whole table is ready. Rarely have so many been so wrong about being ready.",
    ),
    "lobby.idle": (
        "Still waiting. The candles are getting shorter, and so is my patience.",
        "Take your time. Camelot has only been under threat for several centuries.",
        "Is anyone going to start this, or shall we simply gaze at one another all night?",
    ),
    # Opening ---------------------------------------------------------------
    "start.opening": (
        "Hear ye, hear ye! The game begins. Check your phones, guard your faces, and trust... absolutely no one.",
        "Let the treachery commence! Your roles await. Do try not to gasp out loud.",
        "And so it begins. Loyal servants of Arthur, minions of Mordred. Look at your phones, and keep your poker face.",
        "The gates of Camelot close behind you. Somewhere among you, evil grins politely. Look at your roles.",
    ),
    "night.intro": (
        "Night falls over Camelot. Read your secrets in silence. No gasping. No winking. I'm looking at you.",
        "The night reveals its secrets. Study your phone, memorise what you see, and act natural. Naturally.",
        "Darkness settles over the castle. The wicked know each other now. The good know... very little. As usual.",
    ),
    "night.complete": (
        "Dawn breaks. Everyone knows exactly what they know. Act accordingly.",
        "The sun rises, and so does suspicion. Let us begin.",
        "Morning, everyone. Evil had a lovely night, I'm told.",
    ),
    # Missions --------------------------------------------------------------
    "mission.1": (
        "Mission one! A gentle start. Nobody has any evidence, which has never stopped anyone.",
        "The first quest. A blank slate. Let's see who scribbles on it first.",
    ),
    "mission.2": (
        "Mission two. The plot thickens like week-old porridge.",
        "On to the second quest. Grudges are now fully loaded.",
    ),
    "mission.3": (
        "Mission three. The middle of the story, where everyone starts lying more confidently.",
        "The third quest. Half the realm hangs in the balance. No pressure.",
    ),
    "mission.4": (
        "Mission four. With a big table, evil needs two fails here. Do the maths, then distrust the mathematicians.",
        "The fourth quest. Things are getting dramatic. I've ordered extra candles.",
    ),
    "mission.5": (
        "Mission five. The final quest. Everything comes down to this. Please, nobody faint.",
        "The last quest! All of Camelot is watching. Mostly through its fingers.",
    ),
    "leader.new": (
        "The crown passes on. Try to do better than the last one.",
        "A new leader takes the throne. It's warm. Don't ask why.",
        "Fresh leadership! Same old suspicion.",
        "The crown moves along, like a hot potato with a coat of arms.",
    ),
    # Discussion ------------------------------------------------------------
    "discussion.start": (
        "Discuss! Accuse! Defend! Point dramatically!",
        "The floor is open. Make your case, and make it loud.",
        "Talk amongst yourselves. Preferably about each other.",
    ),
    "discussion.final10": (
        "Ten seconds! Wrap up your wild theories.",
        "Ten seconds left. Last chance to accuse someone without evidence.",
        "Ten seconds! Speak now, or forever hold your suspicion.",
    ),
    "discussion.over": (
        "Time! Put the pitchforks down. Gently.",
        "That's enough talk. To the decision!",
        "And the debate is over. Nobody was convinced. Excellent.",
    ),
    # Proposal --------------------------------------------------------------
    "proposal.start": (
        "The leader must now choose a party. Choose wisely, or at least choose quickly.",
        "Time to pick a team. Leader, everyone is judging your every tap.",
        "Assemble your fellowship, my liege. The table is watching your thumbs.",
        "Pick your companions. Remember, friendship is temporary. Voting records are forever.",
    ),
    "proposal.slow": (
        "Any time now, leader. The quest isn't getting any younger.",
        "Still choosing? Even Merlin is getting bored.",
        "The leader deliberates. The rest of us age gracefully.",
    ),
    "proposal.forced": (
        "Fifth proposal! No vote this time. Whatever the leader picks, rides. Democracy has left the building.",
        "Four rejections. This leader's party goes, no questions asked. Choose very, very carefully.",
    ),
    "proposal.locked": (
        "The party is chosen! Now we vote.",
        "The leader has spoken. Let the court decide.",
        "A fellowship is proposed. Prepare your opinions.",
    ),
    # Voting ----------------------------------------------------------------
    "vote.start": (
        "Approve or reject? Vote on your phones. Secretly. Then reveal everything publicly. Fun!",
        "Cast your votes! Every one of them will be shown to everyone. No pressure.",
        "To the ballot! Remember, your vote is secret for about ten seconds.",
        "Vote now. History is watching, and history is a terrible gossip.",
    ),
    "vote.stragglers": (
        "Some of you are still voting. It's a yes or a no, not a sonnet.",
        "We're waiting on a few stragglers. Take your time. We'll just stare at you.",
        "Still deciding? Fascinating. Truly. Do go on.",
        "A few votes remain. The suspense is unbearable. Mostly for me.",
    ),
    "vote.reveal": (
        "The votes are in. Let's see who trusts whom.",
        "And now, the moment of truth. Or at least, the moment of votes.",
        "Reveal the ballots! Let the judging begin.",
    ),
    "vote.approved": (
        "Approved! The quest party rides forth!",
        "The court agrees! Remarkable. Let's see if it regrets it.",
        "The fellowship is approved. Pack light. Trust lighter.",
        "Approved. Off they go, into danger, and possibly into betrayal.",
    ),
    "vote.rejected": (
        "Rejected! Back to the drawing board.",
        "The court says no. The crown moves on.",
        "Denied! That party will not be riding anywhere.",
        "Rejected. Somewhere, a leader quietly sulks.",
    ),
    "vote.unanimous_yes": (
        "Unanimous approval! Either everyone trusts this team, or someone is a very good liar.",
        "Every single vote says yes. That's either beautiful or deeply suspicious.",
    ),
    "vote.unanimous_no": (
        "Unanimous rejection! Nobody liked that. Not even the leader, apparently.",
        "Every vote says no. Ouch. That's going in the history books.",
    ),
    "vote.tie": (
        "A tie! And a tie means rejection. Arithmetic is cruel.",
        "Dead even, which means the party is rejected. Blame mathematics.",
    ),
    "rejection.3": (
        "Three rejections. Two more failed votes would be... a problem. Just saying.",
        "That's three rejected parties. The kingdom grows restless.",
    ),
    "rejection.4": (
        "Four rejections! The next leader's party goes without a vote. Everyone, panic quietly.",
        "Four in a row. The next proposal is binding. Choose like your crown depends on it.",
    ),
    # Quest -----------------------------------------------------------------
    "quest.begins": (
        "The quest begins! Party members, choose your card. Success, or... something else.",
        "Into the wilderness they go. Quest members, play your cards on your phones.",
        "The fellowship departs. Good may only succeed. Evil may do as it pleases. Choose.",
        "Off on the quest! Everyone else, look anywhere except at their faces. Actually no, look right at them.",
    ),
    "quest.sealed": (
        "All the cards are in. Let's shuffle these, shall we?",
        "Every card is sealed. The truth is in the deck.",
        "The cards are played. No take-backsies.",
    ),
    "quest.reveal": (
        "Drumroll, please. Let's reveal the cards. One. By. One.",
        "The moment of truth. Let's open the cards.",
        "Now, let's see what our brave adventurers really did.",
    ),
    "quest.success": (
        "Success! The quest triumphs! Everyone act surprised.",
        "Victory! The quest succeeds! Evil is either sleeping, or scheming.",
        "A successful quest! Good gains ground. For now.",
        "Clean as a whistle! The quest is a success.",
    ),
    "quest.fail_one": (
        "One fail. Just one. A single, solitary traitor. How intimate.",
        "Failed! Someone on that quest is not who they say they are.",
        "One betrayal, and the quest falls. Look around. One of them did it.",
    ),
    "quest.fail_many": (
        "Multiple fails! The traitors aren't even trying to hide now.",
        "More than one fail! Evil brought friends to this quest.",
        "Several betrayals! That wasn't sabotage, that was a team-building exercise.",
    ),
    "quest.close_call": (
        "One fail, but quest four needs two. The quest survives. Barely.",
        "A traitor struck, but not hard enough. The quest succeeds on a technicality.",
    ),
    "score.good_two": (
        "Two quests to good. One more and Camelot is saved. Probably.",
        "Good leads two to nothing. Evil, it's time to get creative.",
    ),
    "score.evil_two": (
        "Two failures! One more and evil takes the realm.",
        "Evil leads two to nothing. Good, this is what we call a crisis.",
    ),
    "score.decider": (
        "Two all! It comes down to the final quest!",
        "Level at two apiece. The next quest decides the fate of Camelot!",
    ),
    # Assassin --------------------------------------------------------------
    "assassin.start": (
        "Three quests succeed! But wait. The Assassin may yet strike. Find Merlin, and evil steals the game.",
        "Good has won the quests. Now the Assassin chooses one target. Guess Merlin, and it's all for nothing.",
        "Not so fast, heroes! The Assassin emerges from the shadows. Merlin, try to look ordinary.",
    ),
    "assassin.slow": (
        "The Assassin is taking their time. Somewhere, Merlin is sweating.",
        "Still choosing. Every good player is aging visibly.",
        "Take your time, Assassin. We'll all just hold our breath.",
    ),
    "assassin.strike": (
        "The Assassin has chosen. Let's see if the blade finds its mark.",
        "The dagger falls. Was it Merlin?",
        "A target is chosen. The moment of truth.",
    ),
    "assassin.hit": (
        "It was Merlin! The Assassin strikes true! Evil steals the victory!",
        "Merlin falls! All those clever hints, and look where it got them.",
        "Bullseye! Merlin is found, and evil wins it all!",
    ),
    "assassin.miss": (
        "Not Merlin! The Assassin missed! Good triumphs!",
        "Wrong target! Merlin lives, and Camelot is saved!",
        "The blade misses! Merlin survives! What a performance.",
    ),
    # Endings ---------------------------------------------------------------
    "end.good": (
        "Good wins! Camelot is saved! Please, try to be humble about it.",
        "Victory for the loyal servants of Arthur! The realm endures!",
    ),
    "end.evil_missions": (
        "Three quests failed. Evil wins! Mordred sends his regards.",
        "Evil triumphs! Camelot falls, one sabotaged quest at a time.",
    ),
    "end.evil_assassin": (
        "Evil wins by assassination! Good did all that work for nothing. Delicious.",
        "Merlin is gone, and evil takes the crown. What a twist!",
    ),
    "end.evil_rejections": (
        "Five rejected parties! The kingdom collapses in bureaucracy. Evil wins!",
        "Nobody could agree on anything, so evil wins. Classic committee.",
    ),
    "end.roles": (
        "Now, let's unmask everyone. Prepare to feel betrayed.",
        "Time for the big reveal. Who was who? Brace yourselves.",
    ),
    # Awards ----------------------------------------------------------------
    "awards.intro": (
        "And now, the Royal Honours! Awards nobody asked for, presented with great ceremony.",
        "Before we go, the Court presents its honours. Some are compliments. Most are not.",
        "It's time for the awards! Please hold your applause, and your grudges, until the end.",
    ),
    "award.trusting": (
        "The Golden Retriever Award, for approving nearly everything. Bless your trusting heart.",
        "Most Trusting Knight. Never met a team they didn't like.",
    ),
    "award.skeptic": (
        "The Drawbridge Award, for rejecting almost everything. Nobody gets in. Nobody.",
        "Chief Skeptic of Camelot. Trusted no one, and was right at least once.",
    ),
    "award.traveller": (
        "Most Well-Travelled, for going on the most quests. Frequent rider miles: enormous.",
        "The Wandering Knight Award. Never met a quest they didn't join.",
    ),
    "award.homebody": (
        "The Homebody Award, for going on the fewest quests. Sat by the fire. Very cosy.",
        "Least Invited Knight. They'll tell you it was strategy.",
    ),
    "award.saboteur": (
        "Master Saboteur, for sneaking onto failed quests. Absolutely shameless. We salute you.",
        "The Butterfingers Award, for being on the quests that mysteriously failed.",
    ),
    "award.poker_face": (
        "Best Poker Face, for being evil and going on successful quests anyway. Chillingly patient.",
        "The Wolf in Sheep's Clothing Award. Evil, trusted, and smiling the entire time.",
    ),
    "award.unlucky_leader": (
        "The Rejected Royalty Award, for having their proposals turned down the most. Heavy is the head.",
        "Least Popular Leader. The crown kept slipping off.",
    ),
    "award.kingmaker": (
        "The Kingmaker Award, for leading quests to success. Arthur would be proud.",
        "Best Leader. Picked a winning team, which is more than most can say.",
    ),
    "award.merlin": (
        "And finally, Merlin. Who survived. Hiding in plain sight, like a wizard should.",
        "A special honour for Merlin, who survived the assassin. Clever, clever wizard.",
    ),
    "award.assassin": (
        "And finally, the Assassin, who found Merlin. Terrifyingly good at their job.",
        "A special dishonour for the Assassin, whose aim was perfect. Remind me never to annoy you.",
    ),
    "awards.outro": (
        "Congratulations to all, and especially to the liars. Rematch?",
        "That concludes the ceremony. Your grudges may now be carried into the rematch.",
        "Thank you, thank you. Same time next game? Same betrayals?",
    ),
    "rematch.lobby": (
        "Back to the hall! Shall we betray each other again?",
        "Round two! New roles, same old friends, fresh new lies.",
        "Welcome back to the lobby. Your reputations, sadly, came with you.",
    ),
    "rematch.instant": (
        "Everyone wants a rematch already! Healing is overrated.",
        "A unanimous rematch! Nobody learned a thing. Wonderful.",
    ),
}

# ---------------------------------------------------------------------------
# Spoken, name-free versions of narrator.py premises, keyed by trigger id.
# ---------------------------------------------------------------------------
NARRATOR_PREMISES: dict[int, str] = {
    1: "Fresh game, fresh loyalties, same suspicious eye contact.",
    2: "A rematch. Because apparently, the previous betrayal lacked closure.",
    3: "A new leader holds the crown. Try not to make it look like evidence.",
    4: "This discussion is so quiet, I can hear the alibis fermenting.",
    5: "Everyone is talking. Truth has wisely left the building.",
    6: "Fifteen seconds. Time to promote a hunch into a legal argument.",
    7: "Unlimited discussion has become a hostage situation, with snacks.",
    8: "I heard my name. I assume standards have collapsed.",
    9: "Our leader is marinating that proposal well past its use-by date.",
    10: "Submitted at the bell. Confidence, with the paperwork of panic.",
    11: "The leader selected themselves. A touching vote of self-interest.",
    12: "The leader stayed home. Either humility, or an alibi with excellent tailoring.",
    13: "The identical party returns, now with absolutely no new information.",
    14: "You rejected this party before. Nostalgia truly is incurable.",
    15: "That failed fellowship has been reheated, and plated as strategy.",
    16: "The successful band is back together. The ego tour begins now.",
    17: "Someone has a third consecutive quest. Frequent-flyer treason points unlocked.",
    18: "Mission three, and someone still has cleaner boots than everyone else.",
    19: "One member changed. Behold, radical reform.",
    20: "The rejected leader returns, carrying no resentment whatsoever.",
    21: "Unanimous approval. The rare sound of everyone being wrong together.",
    22: "Unanimous rejection. The table has discovered teamwork, through spite.",
    23: "A tie rejects the party. Even arithmetic has trust issues here.",
    24: "Approved by one vote. A mandate written in disappearing ink.",
    25: "Rejected by one vote. Someone just became tonight's group-chat topic.",
    26: "One lone reject, bravely ruining the family photo.",
    27: "One lone approve. Hope is adorable when isolated.",
    28: "Someone rejected a party containing themselves. Self-awareness, or insurance fraud?",
    29: "Every proposed member approved. The product endorsed itself.",
    30: "Several party members rejected their own trip. Read the reviews.",
    31: "Same party, different vote. Character development, or weather vane?",
    32: "Someone keeps approving. A golden retriever has entered parliament.",
    33: "Someone keeps rejecting. The drawbridge has a drawbridge.",
    34: "Two rejected parties. Mild dysfunction has become a theme.",
    35: "Three rejections. The round table is now mostly sharp corners.",
    36: "Four rejections. The next leader gets consent removed from the menu.",
    37: "Fifth proposal. Binding, vote-free, and sponsored by consequences.",
    38: "First proposal approved. Suspiciously efficient. Check everyone for wires.",
    39: "After all those rejections, a quest finally escaped committee.",
    40: "Zero fails. Either heroes, cowards, or excellent accountants.",
    41: "Exactly one fail. A solo artist has entered the charts.",
    42: "Multiple fails. Treason has formed a project team.",
    43: "Quest four survived one fail, because the large-table rules enjoy chaos.",
    44: "Narrowly approved, successfully completed. Democracy accidentally shipped a feature.",
    45: "Unanimously approved, then failed. Put that confidence in a museum.",
    46: "A divisive vote produced success. Consensus remains overrated.",
    47: "Someone appears on consecutive failures. An unfortunate loyalty programme.",
    48: "The same core keeps succeeding. Competence is becoming deeply suspicious.",
    49: "Good leads two-nil. Evil may now begin pretending this was the plan.",
    50: "Evil leads two-nil. The optimism budget has been cut.",
    51: "Good ties it, two-all. The finale has acquired expensive lighting.",
    52: "Evil ties it, two-all. Nobody's pulse needed that.",
    53: "Mission five decides everything. Please place all terrible instincts on the table.",
    54: "Three successes summon the Assassin. Victory comes with an invoice.",
    55: "Someone disconnected. Even their internet rejected the proposal.",
    56: "Our wanderer returns from the void, allegedly with the same opinions.",
    57: "Someone reconnects, again. Their wi-fi is playing its own social deduction game.",
    58: "Connection trouble is spreading. Mordred has apparently hired the router.",
    59: "A spectator arrives at the dramatic bit. Impeccable rubbernecking.",
    60: "Chat has been silent for minutes. The screenshots must be thriving.",
    61: "Chat just caught fire. Facts are not expected to survive.",
    62: "Someone keeps entering the conversation, like an unpaid subscription.",
    63: "The table keeps accusing the same person. Repetition: evidence's cheaper cousin.",
    64: "Trust. Sus. Obvious. Definitely. The four horsemen of the bad argument.",
    65: "You rang? I was busy documenting the confidence-to-evidence ratio.",
    66: "Who is evil? Statistically, someone currently acting extremely helpful.",
    67: "Trust the person whose certainty has the shortest warranty.",
    68: "Vote with your conscience. Then blame the seating chart.",
    69: "Are you suspicious? Asking has moved the needle in an unhelpful direction.",
    70: "Insulting the narrator is legal. But your voting record remains discoverable.",
    71: "Flattery accepted. It will purchase exactly zero secret information.",
    72: "Spoilers cost one soul, and I still refuse to provide them.",
    73: "I am single by court order, and emotionally committed to bad decisions.",
    74: "A roast, you say? Your alibi has the structural integrity of wet pastry.",
    75: "Blame me if you like. I have minutes. You have a voting record.",
    76: "I cannot classify that question, which may be its strongest quality.",
    77: "The Assassin steps forward. Good's celebration has entered a probationary period.",
    78: "The Assassin is taking their time, aging every good player visibly.",
    79: "Merlin identified. Evil read the room, and then set fire to the library.",
    80: "The Assassin missed. All that menace, straight into the scenery.",
    81: "Three failed quests. Evil wins by making disaster look procedural.",
    82: "Merlin falls. Evil steals the ending, after good wrote three acts.",
    83: "The Assassin missed, and good survives the world's least relaxing victory lap.",
    84: "The winners came from behind. Never underestimate spite with momentum.",
    85: "A clean sweep. The losing side was present in a largely decorative capacity.",
    86: "A two-all final quest decided it. Subtlety died several minutes ago.",
    87: "The most accused player was good after all. Please recycle your accusations responsibly.",
    88: "The most defended player was evil. Those passionate defenders may collect their receipts.",
    89: "Someone's votes gave evil a remarkably comfortable chair.",
    90: "Someone's votes kept opposing evil. Annoying, but in retrospect, heroic.",
    91: "Someone attended an impressive number of failed quests. Terrible tourism.",
    92: "Someone attended an impressive number of successes. A boastful letter to the court is incoming.",
    93: "The rematch requests begin before the emotional paperwork is complete.",
    94: "Everyone wants the rematch immediately. Healing has been unanimously rejected.",
}

# Spoken versions of narrator._DELIVERIES, in the same order (1-based ids).
NARRATOR_DELIVERIES: tuple[str, ...] = (
    "The court records this without judgement. Mostly.",
    "Do sit with that.",
    "No refunds on certainty.",
    "The minutes will be unkind.",
    "A perfectly normal kingdom.",
    "Proceed with undeserved confidence.",
    "I have sharpened the footnote.",
    "History is already smirking.",
    "Nothing ominous there.",
    "The tavern odds just moved.",
    "Your dignity remains optional.",
    "Please, continue incriminating yourselves.",
    "Camelot deserves better gossip.",
    "An adult has not been located.",
    "This will age beautifully.",
    "The crown accepts no liability.",
    "Someone pour the evidence another drink.",
    "I adore a preventable crisis.",
    "The confidence is exquisite.",
    "And, scene.",
)

# Spoken double-act follow-ups, keyed like narrator.DOUBLE_ACT_FOLLOWUPS.
NARRATOR_FOLLOWUPS: dict[int, tuple[str, ...]] = {
    23: (
        "No, staring at the dissenters will not change the count.",
        "The motion fails. The grudges, however, pass unanimously.",
        "Please direct complaints to mathematics, who will ignore them.",
        "A dead heat is still dead. Lovely symmetry, though.",
    ),
    36: (
        "One more rejection, and democracy is taken behind the castle.",
        "The fifth leader is warming up their benevolent dictatorship.",
        "Do reject again. I enjoy watching consequences put on boots.",
        "Next proposal comes with no ballot, and several raised eyebrows.",
    ),
    37: (
        "You had four chances to cooperate. The rulebook has stopped asking.",
        "The table wanted certainty. It has received compulsory tourism.",
        "No vote this time. Your previous votes were quite sufficient.",
        "Consent has left a note, and gone to the tavern.",
    ),
    42: (
        "At least the traitors found colleagues, in this economy.",
        "That was less sabotage than a departmental initiative.",
        "One fail whispers. Several fails submit a quarterly report.",
        "The conspiracy has apparently secured group health insurance.",
    ),
    43: (
        "One saboteur did the work, and still failed the assignment.",
        "Somewhere, evil is rereading the two-fail footnote, very slowly.",
        "A technical success. The most irritating species of success.",
        "The second fail was invited. It declined to attend.",
    ),
    45: (
        "Everyone trusted the party. The party treasured that mistake.",
        "A perfect mandate, followed by an imperfect little catastrophe.",
        "Please keep your unanimous confidence away from heavy machinery.",
        "Consensus has requested that this result be sealed.",
    ),
    55: (
        "We shall preserve their seat, and misremember their arguments.",
        "Until they return, their silence is their strongest defence.",
        "The empty chair has already improved its voting record.",
        "Someone tell the router that desertion is not a legal vote.",
    ),
    57: (
        "At this point, the router deserves its own loyalty card.",
        "Welcome back. Again. The void says hello.",
        "Their connection has now had more reversals than the table.",
        "The wi-fi remains the evening's most convincing traitor.",
    ),
    58: (
        "If the candles start buffering, abandon the castle.",
        "The network has rejected the entire fellowship.",
        "Mordred denies responsibility, which is honestly suspicious.",
        "Please accuse one another locally while service is restored.",
    ),
}


def all_clips() -> dict[str, str]:
    """Return every clip id mapped to its spoken text."""
    clips: dict[str, str] = {}
    for cue, takes in EVENT_CUES.items():
        for index, text in enumerate(takes, 1):
            clips[f"e.{cue}.{index}"] = text
    for trigger_id, text in NARRATOR_PREMISES.items():
        clips[f"n{trigger_id}"] = text
    for index, text in enumerate(NARRATOR_DELIVERIES, 1):
        clips[f"d{index}"] = text
    for trigger_id, takes in NARRATOR_FOLLOWUPS.items():
        for index, text in enumerate(takes, 1):
            clips[f"n{trigger_id}f{index}"] = text
    return clips
