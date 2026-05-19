import * as THREE from 'three';
import { makePotato } from './potato.js';
import { WEAPONS } from './weapons.js';
import { TEAM_COLORS } from './arena.js';
import { Pickup } from './pickup.js';

// Combat archetypes — drive weapon selection AND engagement behavior so each
// bot fights in a distinct, recognizable way. Picked at spawn alongside chat
// personality (which is independent).
//   - Sniper:  prefers boomstick, keeps distance, picks high ground
//   - Rusher:  prefers shotguns/SMG, closes aggressively, dodges more
//   - Support: prefers AR/shotgun, mid-range, more team-aware
//   - Balanced: uniform-weighted, no specialization
const ARCHETYPES = {
  sniper:   { weights: { boomstick: 60, fryer: 8,  spudling: 4,  hashbrowner: 2,  masher: 2,  spudgun: 14, tossor: 10 }, aggressionMult: 0.85, dodgeMult: 1.10, rangeBias: 1.25 },
  rusher:   { weights: { boomstick: 2,  fryer: 8,  spudling: 22, hashbrowner: 18, masher: 28, spudgun: 14, tossor: 8  }, aggressionMult: 1.30, dodgeMult: 1.20, rangeBias: 0.80 },
  support:  { weights: { boomstick: 6,  fryer: 28, spudling: 16, hashbrowner: 16, masher: 8,  spudgun: 16, tossor: 10 }, aggressionMult: 1.00, dodgeMult: 1.05, rangeBias: 1.00 },
  balanced: { weights: { boomstick: 10, fryer: 20, spudling: 14, hashbrowner: 14, masher: 10, spudgun: 22, tossor: 10 }, aggressionMult: 1.00, dodgeMult: 1.00, rangeBias: 1.00 },
};
const ARCHETYPE_KEYS = Object.keys(ARCHETYPES);

function pickArchetype() {
  // Slight bias toward balanced so the mix doesn't feel too gimmicky.
  const r = Math.random();
  if (r < 0.20) return 'sniper';
  if (r < 0.45) return 'rusher';
  if (r < 0.70) return 'support';
  return 'balanced';
}

function pickBotWeapon(archetype = 'balanced') {
  const weights = ARCHETYPES[archetype]?.weights || ARCHETYPES.balanced.weights;
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [key, w] of entries) {
    r -= w;
    if (r <= 0) return key;
  }
  return entries[0][0];
}

const SPEED = 5.0;
const SPRINT_MULT = 1.5;
const GRAVITY = 24;
const JUMP_VEL = 8.5;
const SPAWN_INVULN = 2.0;

// Per-weapon effective firing range. Bots will only commit to ENGAGE state when
// the target is within this distance — beyond it they reposition or close in.
const WEAPON_RANGE = {
  spudgun:    32,
  fryer:      26,
  hashbrowner: 14,
  masher:     14,   // shotgun — close range
  spudling:   26,
  boomstick:  70,   // sniper — long sight line
  tossor:     22,   // grenade launcher — slow projectile
};

// Team intel staleness window — older entries are ignored.
const INTEL_FRESH_MS = 4000;

// AI personalities — assigned at spawn. Drives both stat tweaks and chat lines.
// Eleven flavors so the chat reads with variety even with many bots alive.
const PERSONALITIES = {
  rude:        { aggression: 1.20, dodgeMult: 0.85, helpBuddy: 0.3, color: '#ff5e3a' },
  kind:        { aggression: 0.90, dodgeMult: 1.00, helpBuddy: 1.6, color: '#5effb8' },
  sacrificial: { aggression: 1.40, dodgeMult: 0.55, helpBuddy: 2.2, color: '#ffd700' },
  cocky:       { aggression: 1.30, dodgeMult: 0.85, helpBuddy: 0.6, color: '#c45eff' },
  quiet:       { aggression: 1.00, dodgeMult: 1.10, helpBuddy: 1.0, color: '#a4d8ff' },
  tryhard:     { aggression: 1.10, dodgeMult: 1.30, helpBuddy: 0.9, color: '#ff8a3c' },
  sarcastic:   { aggression: 1.00, dodgeMult: 1.00, helpBuddy: 0.7, color: '#ffce5e' },
  hyper:       { aggression: 1.35, dodgeMult: 1.20, helpBuddy: 1.1, color: '#ff8a3c' },
  nerd:        { aggression: 0.95, dodgeMult: 1.15, helpBuddy: 1.2, color: '#aef5b8' },
  flirty:      { aggression: 1.05, dodgeMult: 1.05, helpBuddy: 0.8, color: '#ffb8d8' },
  paranoid:    { aggression: 0.85, dodgeMult: 1.30, helpBuddy: 1.0, color: '#c8a0ff' },
};
const PERSONALITY_KEYS = Object.keys(PERSONALITIES);

// Big-bank chat lines — every personality has many distinct lines per event,
// and a global dedup history (see pickLineDedup) ensures the same wording
// doesn't repeat across teammates while it's still on screen.
const CHAT_LINES = {
  spawn: {
    rude:        ["whoever made this map is trash", "back already? pathetic", "ugh, you guys again", "I'm carrying this", "wake me when it's over"],
    kind:        ["hey team! good luck out there", "stick together folks", "we got this!", "I believe in us", "remember to breathe, friends"],
    sacrificial: ["I'll draw fire, push up!", "use me as bait, GO", "ready to die for the cause", "spend my body wisely", "I'm the meatshield, advance"],
    cocky:       ["watch and learn", "ez clap incoming", "showtime", "try to keep up", "highlight reel starts now"],
    quiet:       ["...", "ok", ".", "back.", "hm"],
    tryhard:     ["focus up team", "lock in", "comms only on calls", "execute the plan", "let's run it back, clean this time"],
    sarcastic:   ["oh joy, another round", "this'll be fun", "wow, can't wait", "such excite", "another opportunity to disappoint"],
    hyper:       ["LETSGOOO", "READY READY READY", "i drank too much coffee guys", "FEELS GOOD MAN", "frags incoming!!!"],
    nerd:        ["TTK calculations look favorable", "engaging optimal route", "running the meta build", "stats incoming", "remember to check angles"],
    flirty:      ["miss me?", "back for more <3", "looking sharp out there", "behave, you", "say hi to the cute one"],
    paranoid:    ["someone's pre-aiming I can feel it", "they know our spawn", "are they cheating?", "I trust nobody here", "watch the back lines"],
  },
  kill: {
    rude:        ["get rekt", "you're trash", "skill issue", "uninstall please", "literally bot behavior"],
    kind:        ["sorry about that!", "good game friend", "no hard feelings ok?", "great effort though", "you'll get me next time"],
    sacrificial: ["FOR THE TEAM", "one less for them", "scoreboard says you're welcome", "die so others may live", "victory inches forward"],
    cocky:       ["too easy", "couldn't even hit me", "this is my server", "highlight that one", "press F to respect me"],
    quiet:       ["mashed.", "gg", "down.", "next.", "."],
    tryhard:     ["target down", "next", "clean shot", "minus one", "objective: progress"],
    sarcastic:   ["oh look, a kill", "wow what a shock", "shocking outcome", "very surprised right now", "I'm as stunned as you"],
    hyper:       ["BOOOOM", "GET MASHED LMAOOO", "FRAGGGG", "TASTY", "OH MY DAYS"],
    nerd:        ["statistically inevitable", "as predicted", "graph spike incoming", "K/D adjusted", "data point acquired"],
    flirty:      ["was it good for you too?", "tag, you're dead", "you stared a little too long", "kiss of death", "thanks for the dance"],
    paranoid:    ["finally got one", "saw that coming for hours", "told you they peeked", "knew it knew it knew it", "they had bad timing this time"],
  },
  death: {
    rude:        ["that hit was bs", "lag", "report this guy", "no way that was legit", "fix your servers"],
    kind:        ["ow! good shot", "well played", "fair fight", "respect", "you deserved that one"],
    sacrificial: ["AVENGE ME", "GET THEM", "MY DEATH MEANS NOTHING WITHOUT VICTORY", "use the distraction", "do not waste this"],
    cocky:       ["lucky", "wouldn't happen 1v1", "lag on my end clearly", "bring it next time", "you'll never get me again"],
    quiet:       ["...", ".", "ow", "down"],
    tryhard:     ["respawning, hold the line", "rotate to me", "mistake noted", "I had a 0.18 reaction, brb", "stack up, rerun"],
    sarcastic:   ["love being dead", "great team play", "wow, didn't expect THAT", "amazing support, thanks", "i guess i'll just respawn forever"],
    hyper:       ["NOOOOO", "AAAAA", "ow ow ow ow", "RAGE QUIT NOT", "RESPAWNING ANGRY"],
    nerd:        ["variance, it happens", "outlier event", "tilted by 1 standard deviation", "fascinating angle", "I want a replay file"],
    flirty:      ["catch me if you can", "you're rough today", "playing hard to get?", "ooh feisty", "fine, take me"],
    paranoid:    ["KNEW IT", "they were waiting for me specifically", "stream-snipers everywhere", "spawn camped, told you", "they have wallhacks"],
  },
  buddyDown: {
    rude:        ["he was useless anyway", "should've ducked", "carrying solo now"],
    kind:        ["NO! I'll avenge you", "buddy down :(", "you'll be missed friend"],
    sacrificial: ["I'M COMING", "MY TURN NOW", "your sacrifice fuels me"],
    cocky:       ["watch a pro work", "fine, I'll do it myself", "guess I'm the carry"],
    quiet:       ["...", "noted.", "alone now"],
    tryhard:     ["buddy down, recalibrating", "1v1 mode engaged", "solo carry incoming"],
    sarcastic:   ["wonderful, now I'm alone", "love that for me", "what a lovely surprise"],
    hyper:       ["NOOO MY BUDDYYY", "VENGEANCE TIME", "they took my best friend!!"],
    nerd:        ["squad coherence dropped to zero", "reassessing engagement matrix", "down one teammate, adjusting"],
    flirty:      ["aww, my partner!", "guess it's just me, lonely girl", "now who'll hold the door for me"],
    paranoid:    ["they're picking us off one by one", "we're being hunted", "I'm next aren't I"],
  },
  lowHp: {
    rude:        ["stop hitting me", "leave me alone", "find someone else to bully"],
    kind:        ["I need help!", "anyone got a medkit?", "support please <3"],
    sacrificial: ["take me, save the team", "going down swinging", "I'll trade, ready"],
    cocky:       ["barely a scratch", "I've taken worse", "still in this"],
    quiet:       ["hurt", "low", "..."],
    tryhard:     ["low HP, falling back", "ratting until regen", "need 4s breathing room"],
    sarcastic:   ["this is fine", "loving every minute", "couldn't be better"],
    hyper:       ["IM DYIIIING", "HEAL ME HEAL ME", "ow ow ow ow"],
    nerd:        ["HP below threshold, recommend rotation", "non-optimal trade incoming", "regen ETA 11 seconds"],
    flirty:      ["come save me, hero?", "I look so cute when I'm bleeding", "rescue arc starts now"],
    paranoid:    ["I knew they'd find me here", "the camper got me again", "told you this corner was bad"],
  },
  bounty: {
    rude:        ["everyone's mad lol", "salt detected", "you all watch streams of me"],
    kind:        ["uh oh I'm popular!", "thanks for the attention friends"],
    sacrificial: ["come at me, all of you", "FREE BOUNTY HERE"],
    cocky:       ["queue forms here", "everyone wants a piece", "the price on my head is well-earned"],
    quiet:       ["target.", "noted.", "fine."],
    tryhard:     ["bounty acknowledged", "playing extra safe now", "minimum exposure protocol"],
    sarcastic:   ["great, the popular one", "wow what an honor", "love being everyone's target"],
    hyper:       ["BOUNTY MEEEE LETSGO", "THIS IS SO COOL", "FAMOUS NOW"],
    nerd:        ["probability of survival dropping", "switching to defensive heuristic", "increased risk vector"],
    flirty:      ["mmm, all eyes on me", "famous girl", "is it the hair?"],
    paranoid:    ["told you they'd come for me", "they coordinated this", "the wallhackers chose me"],
  },
  taunt: {
    rude:        ["L bozo", "ratio + skill issue", "imagine missing that"],
    kind:        ["you're improving!", "good try!"],
    sacrificial: ["use the opening I made!"],
    cocky:       ["was that supposed to hurt?", "weak"],
    quiet:       ["yawn", "..."],
    tryhard:     ["spacing was off", "you over-peeked"],
    sarcastic:   ["world-class aim, truly", "olympic dodging"],
    hyper:       ["WOOOOOO", "GO TEAM GOOO", "spuds rising!!"],
    nerd:        ["the meta is shifting", "interesting microplay"],
    flirty:      ["winking at the enemy team", "blow them a kiss"],
    paranoid:    ["something is wrong with this lobby", "they're talking to each other"],
  },
  highGround: {
    rude:        ["high ground, suckers", "look up nerds"],
    kind:        ["I've got eyes on top, calling shots"],
    sacrificial: ["I'll spot from up here, push!"],
    cocky:       ["king of the tower"],
    quiet:       ["up.", "scoping"],
    tryhard:     ["tower secured, calling pushes"],
    sarcastic:   ["found a ladder, how exciting"],
    hyper:       ["I'M ON THE TOWERRR", "VIEW UP HEREEE"],
    nerd:        ["elevation grants +20% accuracy roughly"],
    flirty:      ["look up here, cuties"],
    paranoid:    ["if they snipe me from down there I'll lose it"],
  },
  pushThrough: {
    rude:        ["we're cooked, push through anyway", "no more turtling losers"],
    kind:        ["we got this team! push as one"],
    sacrificial: ["I'LL LEAD, FOLLOW ME", "USE MY BODY"],
    cocky:       ["time to comeback flex"],
    quiet:       ["push.", "now."],
    tryhard:     ["coordinated push on my mark", "we move as one"],
    sarcastic:   ["sure, dying in their spawn now"],
    hyper:       ["RAAAAGGGHHHH PUSHHH", "MOMENTUM RALLYYY"],
    nerd:        ["aggression slope flipping favorable"],
    flirty:      ["pushing past their lines, hold tight"],
    paranoid:    ["if this fails it's everyone's fault not mine"],
  },
};

// Buddy relationship types — assigned to a pair at the moment they buddy-up.
// UNIQUE types are capped at one active pair per match (Game enforces this);
// they're meant to feel iconic when they show up.
export const UNIQUE_BUDDY_TYPES = new Set(['wwII_vet', 'pirates', 'detectives', 'astronauts']);
export const BUDDY_TYPES = [
  { key: 'couple',         weight: 14 },
  { key: 'bestfriends',    weight: 14 },
  { key: 'rivals',         weight: 10 },
  { key: 'mentor',         weight: 9  },
  { key: 'siblings',       weight: 10 },
  { key: 'exes',           weight: 8  },
  { key: 'roommates',      weight: 8  },
  { key: 'gym_bros',       weight: 8  },
  { key: 'theater_kids',   weight: 7  },
  { key: 'conspiracy',     weight: 7  },
  { key: 'dad_son',        weight: 7  },
  { key: 'wrestlers',      weight: 6  },
  { key: 'boomers',        weight: 6  },
  { key: 'wwII_vet',       weight: 5  },  // unique — "that one guy"
  { key: 'pirates',        weight: 4  },  // unique
  { key: 'detectives',     weight: 4  },  // unique
  { key: 'astronauts',     weight: 3  },  // unique
];
function pickBuddyType() {
  const total = BUDDY_TYPES.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of BUDDY_TYPES) { r -= t.weight; if (r <= 0) return t.key; }
  return 'bestfriends';
}

// Type-specific banter overlays the personality lines for buddy-flavored
// events. If a key is missing for a type the bot falls back to the personality
// bank in CHAT_LINES.
const BUDDY_LINES = {
  couple: {
    spawn:      ["babe, i'm back", "where's my darling?", "ready honey?", "miss me, sweetheart?"],
    near:       ["stay close love <3", "got you babe", "i'm right behind you, hon", "we got this, my heart"],
    buddyDown:  ["NOOOO MY LOVE", "babe noooo", "they took my honey", "i can't go on without you"],
    buddyKill:  ["that's my pumpkin!", "atta boy honey", "go off, my love", "yes darling YES"],
    avenged:    ["this is for my darling", "they hurt my babe", "you don't TOUCH my partner"],
    idle:       ["thinking of you ❤", "you ok over there sweetie?", "almost time for a smooch break", "my hero", "stay safe out there hon"],
  },
  bestfriends: {
    spawn:      ["BRO you made it", "PARTNER", "the dynamic duo rides again", "MY GUY"],
    near:       ["got your six bestie", "ride or die", "we 1v1v1 the world", "back to back, like always"],
    buddyDown:  ["NOT MY BEST FRIEND", "BRO NOOOOO", "we had a HANDSHAKE", "this is personal now"],
    buddyKill:  ["that's MY guy", "atta BOY", "what a frag bestie", "POG POG POG"],
    avenged:    ["for my best friend", "you don't touch the bro", "vengeance for the bestie"],
    idle:       ["bro you seein this", "should we open another can after?", "remember high school?", "next round we 1v2 them", "what a session bro"],
  },
  rivals: {
    spawn:      ["i'll outfrag you this round", "watch me, bench warmer", "let's see who's better", "scoreboard's mine today"],
    near:       ["don't slow me down", "race you to first frag", "watch a real player", "you're crampin my style"],
    buddyDown:  ["welp guess i carry", "should've listened to me", "useless as always", "knew i'd outlive you"],
    buddyKill:  ["lucky shot", "ok ok i'm impressed", "still beating your KD though", "fluke"],
    avenged:    ["nobody beats us but ME", "you weren't supposed to die yet", "fine, i avenged you, happy?"],
    idle:       ["how many kills you on", "i'm ahead, by the way", "stop following me", "you missed an easy one earlier"],
  },
  mentor: {
    spawn:      ["rookie, with me", "stay tight, kid", "watch and learn", "follow my lead apprentice"],
    near:       ["good positioning, kid", "spacing — keep spacing", "you're improving", "almost a pro now"],
    buddyDown:  ["i should've protected the kid", "they were so young", "rest easy rookie", "i failed my student"],
    buddyKill:  ["look at my student go", "they grow up so fast", "i taught them that", "see? exactly like i said"],
    avenged:    ["this is for the kid", "they messed with my apprentice", "lesson incoming"],
    idle:       ["remember the basics", "check your six, rookie", "breathe before you peek", "footsteps reveal everything"],
  },
  wwII_vet: {
    // "That one guy" — roleplays as a WW2 soldier. Frequent and very on-brand.
    spawn:      ["reporting for duty, soldier", "the eastern front again, eh?", "ready to push the line", "for the regiment", "saddle up, GI"],
    near:       ["stay low, son", "keep moving, the line holds", "remember your training, kid", "we held the line at Bastogne, we hold it here"],
    buddyDown:  ["MEDIC!! MEDIC!!", "another good man gone", "tell his folks back home...", "he died like a soldier", "fix bayonets!! we PUSH"],
    buddyKill:  ["nice work soldier", "by the book, soldier", "for company D!", "Patton would be proud"],
    avenged:    ["for my brother in arms", "the line holds, soldier", "you don't take a man from MY squad"],
    idle:       ["i can still hear the artillery in my dreams", "the radio's quiet... too quiet", "back in '44 we did this with bolt-actions", "they don't make them like Sergeant Murphy anymore", "remember the cold? god, the cold", "MOVE UP, MOVE UP, this is not a drill", "the brass don't tell you about the smell"],
  },
  siblings: {
    spawn:      ["ugh, the family reunion", "mom made us team up again", "sup sis", "bro you AGAIN"],
    near:       ["stop hitting me", "i'm telling mom", "your turn to take point", "no shoving, dweeb"],
    buddyDown:  ["I'M TELLING MOM", "you idiot sibling", "now you'll NEVER beat my KD", "sib down :("],
    buddyKill:  ["finally, not embarrassing the family", "ok ok, decent for you", "better than last thanksgiving"],
    avenged:    ["YOU TOUCH MY SIBLING", "only I get to bully them", "FOR BLOOD"],
    idle:       ["remember when we set the lawn on fire", "mom called btw", "thanksgiving's gonna be awkward", "i never told her about the vase"],
  },
  exes: {
    spawn:      ["...oh. it's you.", "this is professional only", "we're being adults", "act normal please"],
    near:       ["stay out of my line", "no eye contact please", "the past is the past", "stop standing so close"],
    buddyDown:  ["i can't process this", "okay we're done flirting", "i'm not crying, you are"],
    buddyKill:  ["that was hot — i mean nice", "good shot, stranger", "professional. very professional."],
    avenged:    ["i still cared", "they didn't deserve you", "old habits"],
    idle:       ["i found your hoodie last week", "i moved on btw", "we never talk about the cabin", "you got a haircut?"],
  },
  roommates: {
    spawn:      ["you finally moved off the couch", "rent is due btw", "did you do dishes?", "the wifi was you AGAIN"],
    near:       ["clean up your shells", "stop hogging the lane", "your turn to die first", "i ate your leftovers, sorry"],
    buddyDown:  ["AND I'M STUCK WITH THE BILLS", "great, now i pay alone", "RIP roomie", "the apartment feels empty already"],
    buddyKill:  ["that was almost as good as the rent check", "dishes are MINE this week", "good roommate energy"],
    avenged:    ["that's for eating my leftovers", "you DON'T touch my flatmate", "the apartment avenges"],
    idle:       ["did you pay the gas bill", "the landlord called", "your stuff is in a box again", "i need my space"],
  },
  gym_bros: {
    spawn:      ["DO YOU EVEN LIFT", "hypertrophy phase, brother", "no rest days", "LET'S GO MODE ENGAGED"],
    near:       ["SPOT ME", "GAINS time", "you got this BROOO", "form check, form check"],
    buddyDown:  ["MY LIFTING PARTNER", "leg day was his favorite", "to the gym, in his memory"],
    buddyKill:  ["THAT'S MY PROTEIN PARTNER", "PR! PR!", "MORE PLATES MORE FRAGS"],
    avenged:    ["DIDN'T SKIP LEG DAY FOR THIS", "you cooked my swole brother", "BENCH-MAX REVENGE"],
    idle:       ["chest day later", "we hitting the bar after?", "i'm on creatine", "no carbs for me sorry"],
  },
  theater_kids: {
    spawn:      ["AND SCENE", "the curtain rises once more!", "places everyone!", "we open on a battlefield..."],
    near:       ["follow my blocking", "project, darling, project!", "step into the spotlight", "this is YOUR moment"],
    buddyDown:  ["OH WHAT TRAGEDY", "ACT TWO HAS A DEATH IN IT", "*sobs in dramatic monologue*", "exeunt, pursued by a bear"],
    buddyKill:  ["BRAVO, BRAVO", "encore!", "the awards committee is watching", "stunning performance"],
    avenged:    ["for the playwright!", "this is my soliloquy", "REVENGE: a play in one act"],
    idle:       ["i'm method acting today", "the lighting in this map is wrong", "we should do a musical", "my agent will hear about this"],
  },
  conspiracy: {
    spawn:      ["it's started", "they were waiting for us", "the signs are everywhere", "they know we're on to them"],
    near:       ["check your six AND your radio", "trust no one but me", "the comms are bugged", "they're listening"],
    buddyDown:  ["I TOLD YOU THEY WERE WATCHING", "we knew too much", "they'll come for me next", "DON'T TRUST THE MEDICS"],
    buddyKill:  ["another agent down", "they're thinning out", "the truth wins, partner"],
    avenged:    ["one less puppet master", "the conspiracy weakens", "DEEP STATE DOWN"],
    idle:       ["the moon isn't real btw", "the spuds are listening", "they put fluoride in the ammo", "wake UP, sheeple", "the gluten was psyops"],
  },
  dad_son: {
    spawn:      ["hey there, champ", "I told your mother we'd team up", "ready, kiddo?", "alright son, focus"],
    near:       ["stay behind me, buddy", "watch your old man work", "you're doing great, sport"],
    buddyDown:  ["my BOY", "I should've shielded him", "I let my son down", "go home, kid... oh."],
    buddyKill:  ["that's my BOY", "atta-boy son", "proud of you, kid", "you saw me do that once, huh?"],
    avenged:    ["NOBODY hurts my son", "that's for my boy", "dad mode activated"],
    idle:       ["how's school?", "no phones in the lobby, son", "i remember when you were this tall", "i'm not mad, just disappointed"],
  },
  wrestlers: {
    spawn:      ["TAG TEAM ASSEMBLE", "READYYY TO RUMBLE", "AND HERE WE GO partner", "the crowd is electric"],
    near:       ["TAG ME IN", "i got the hot tag", "watch for the cheap shot", "play to the crowd!"],
    buddyDown:  ["MY TAG PARTNER", "REF, REF, this is illegal", "we'll come back from this", "the crowd is silent..."],
    buddyKill:  ["AND HE PINS HIM", "ONE, TWO, THREE", "GET HIM A SOLO BELT", "AND THE CHAMP IS HERE"],
    avenged:    ["for my partner!", "you don't lay hands on my brother", "AND THE CROWD GOES WILD"],
    idle:       ["the heat in this arena", "i can hear the crowd", "we're the favorites tonight", "i practiced my finisher"],
  },
  boomers: {
    spawn:      ["this game's too dang fast for me", "back in MY day", "kids these days", "what's a 'frag' again"],
    near:       ["walk slow, my knees", "where's my reading glasses", "my hip", "remember vinyl?"],
    buddyDown:  ["good lord, what's the world coming to", "in my day we'd just shake hands", "they don't make 'em like they used to"],
    buddyKill:  ["NOW we're cooking with gas", "see that? old-timer's still got it", "well i'll be"],
    avenged:    ["i fought a war, i can avenge a friend", "punks", "you whippersnappers"],
    idle:       ["my back", "kids on my lawn", "the news today is something else", "i miss diners", "the cable bill came again"],
  },
  pirates: {
    spawn:      ["yarr, set sail!", "shiver me timbers, the crew's together", "we plunder again, mate", "AHOY YE LANDLUBBERS"],
    near:       ["sail close to me, ye scallywag", "watch the rigging", "no quarter given, mate", "to arms!"],
    buddyDown:  ["MY FIRST MATE", "Davy Jones got 'em", "the sea has claimed another", "tip the bottle for 'im"],
    buddyKill:  ["yarr, that's the spirit!", "another doubloon for the chest", "ARRRR", "well plundered, matey"],
    avenged:    ["for the crew!", "AVAST, ye scurvy dog!", "to the keelhaul with ye", "yarr, the bill is paid"],
    idle:       ["these waters be cursed", "i smell rum nearby", "the kraken is real, mate", "where be me parrot"],
  },
  detectives: {
    spawn:      ["the case is afoot", "partner, we have a lead", "the badge never sleeps", "the suspects are nearby"],
    near:       ["watch the angles, partner", "i'll cover the back exit", "we work the perimeter"],
    buddyDown:  ["MY PARTNER, MY PARTNER", "I'll find who did this", "the case just got personal", "i'm taking off the badge"],
    buddyKill:  ["case closed", "suspect down, partner", "by the book"],
    avenged:    ["JUSTICE for the badge", "the case is closed", "you have the right to be dead"],
    idle:       ["something's off about this lobby", "the spudprints don't add up", "i have a hunch", "the chief won't like this"],
  },
  astronauts: {
    spawn:      ["houston, we are go", "all systems nominal", "EVA prep complete", "T-minus zero, partner"],
    near:       ["stay tethered to me", "watch your oxygen", "vector locked, on your six", "comms clear"],
    buddyDown:  ["WE LOST CONTACT", "houston, we have a problem", "they were depressurized too fast", "telemetry zero"],
    buddyKill:  ["mission progress confirmed", "target neutralized, copy", "good shooting, command"],
    avenged:    ["for the mission!", "the void demanded payment", "splashdown for the bandit"],
    idle:       ["the silence up here is loud", "earth looks small from here", "the cosmic radiation is bad today", "my space ice cream melted"],
  },
};

// Reply lines — emitted when a teammate just spoke. Bots pick a reply that
// roughly fits the prior event (e.g. lowHp call → "got you", bounty → "we'll cover").
// Keep these SHORT so chat reads conversational, not monologue-y.
const CHAT_REPLIES = {
  // someone called for help (lowHp)
  toLowHp: {
    rude:        ["fine, hold on", "ugh, coming"],
    kind:        ["coming buddy!", "i got you", "hold on friend!"],
    sacrificial: ["I'M THERE", "use me as shield"],
    cocky:       ["watch me save you", "the carry has arrived"],
    quiet:       ["coming.", "on it."],
    tryhard:     ["rotating to you", "covering"],
    sarcastic:   ["coming i guess", "saving the day, again"],
    hyper:       ["IM COMING IM COMING", "HOLD ON BUDDYYY"],
    nerd:        ["calculating rescue vector", "rotating, ETA 3s"],
    flirty:      ["coming for you, sweetie", "stay alive, cutie"],
    paranoid:    ["told you, told you", "i knew they'd target you"],
  },
  // someone called bounty / "they're all after me"
  toBounty: {
    rude:        ["lol popular", "skill issue but ok"],
    kind:        ["we got you!", "we'll cover you"],
    sacrificial: ["i'll draw aggro", "use me as decoy"],
    cocky:       ["share the love", "leave some kills"],
    quiet:       ["...", "noted."],
    tryhard:     ["covering you", "rotate behind me"],
    sarcastic:   ["enjoy the spotlight", "famous now huh"],
    hyper:       ["WE GOT YOU", "STACK ON ME"],
    nerd:        ["aggro distribution favors you", "we'll absorb"],
    flirty:      ["everyone wants you, cute", "celebrity status"],
    paranoid:    ["they coordinated this", "we knew"],
  },
  // someone just got a taunt / showy line
  toTaunt: {
    rude:        ["L tbh", "wasn't even close"],
    kind:        ["nice one!", "haha"],
    sacrificial: ["clean", "yes"],
    cocky:       ["beat that", "your turn"],
    quiet:       ["lol", "."],
    tryhard:     ["clean", "next"],
    sarcastic:   ["impressive, truly", "wow"],
    hyper:       ["LMAOOO", "INSANEEE"],
    nerd:        ["graphed", "data point logged"],
    flirty:      ["showoff", "easy there hotshot"],
    paranoid:    ["sus...", "too clean if you ask me"],
  },
  // someone died (death) — teammate reaction
  toDeath: {
    rude:        ["bad play", "L"],
    kind:        ["NO!", "RIP friend"],
    sacrificial: ["AVENGE", "i'll get them"],
    cocky:       ["should've followed me", "fine, i carry"],
    quiet:       ["F", "rip"],
    tryhard:     ["regrouping", "noted, recalibrating"],
    sarcastic:   ["fantastic", "team mvp moment"],
    hyper:       ["NOOOO", "RAAGE"],
    nerd:        ["downtime calculated", "tilt registered"],
    flirty:      ["aw, poor thing", "i'll avenge you"],
    paranoid:    ["they camped him", "trap, told you"],
  },
  // someone got a kill — teammate reaction
  toKill: {
    rude:        ["finally", "took long enough"],
    kind:        ["nice shot!", "great job!"],
    sacrificial: ["good", "more for the team"],
    cocky:       ["my turn", "see, easy"],
    quiet:       ["gg.", "noted."],
    tryhard:     ["clean", "next target"],
    sarcastic:   ["wow, a kill, shocking", "oh look at that"],
    hyper:       ["YESSS", "LETS GOOOO", "FRAGS"],
    nerd:        ["data point: positive", "K/D trending up"],
    flirty:      ["that was hot", "mmm, nice work"],
    paranoid:    ["finally, they slipped", "knew it'd happen"],
  },
  // generic — fallback when prior event has no specific bank
  generic: {
    rude:        ["sure", "k"],
    kind:        ["yeah!", "totally"],
    sacrificial: ["agreed", "for the team"],
    cocky:       ["obviously", "of course"],
    quiet:       ["...", "mhm"],
    tryhard:     ["copy", "agreed"],
    sarcastic:   ["how original", "wow, deep"],
    hyper:       ["YEAHHH", "FOR REAL"],
    nerd:        ["consistent with my model", "concurred"],
    flirty:      ["mhm hun", "naturally"],
    paranoid:    ["uh huh", "if you say so"],
  },
};

// Map a prior chat event to a reply-bank key. Returns 'generic' if no specific
// reaction makes sense.
function replyBankFor(priorEvent) {
  if (priorEvent === 'lowHp') return 'toLowHp';
  if (priorEvent === 'bounty') return 'toBounty';
  if (priorEvent === 'taunt' || priorEvent === 'kill') return 'toKill';
  if (priorEvent === 'death' || priorEvent === 'buddyDown') return 'toDeath';
  if (priorEvent === 'pushThrough' || priorEvent === 'highGround') return 'toTaunt';
  return 'generic';
}

// Strip trailing punctuation/emoji and lowercase. Used to fuzz-match lines so
// we treat "gg" and "gg." as the same line for dedup purposes.
function lineKey(s) {
  return s.toLowerCase().replace(/[.!?,…<>:\-]/g, '').replace(/\s+/g, ' ').trim();
}

// Pick a line from the bank that isn't currently in the dedup set. Falls back
// to any line if every option has been used (so chat never stays silent).
function pickLineDedup(event, personality, game) {
  const bank = (CHAT_LINES[event] && CHAT_LINES[event][personality]) || ["..."];
  const used = game && game.usedChatLines ? game.usedChatLines : null;
  if (!used) return bank[Math.floor(Math.random() * bank.length)];
  const fresh = bank.filter((l) => !used.has(lineKey(l)));
  const pool = fresh.length > 0 ? fresh : bank;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return pick;
}

// 1 = bad at the game, 3 = best at the game
const SKILL_PROFILES = {
  1: { aimError: 0.13,  fireRateMult: 1.9, reactionTime: 0.55, dodgeChance: 0.30, jumpRand: 0.05, speedMult: 0.85, leadMult: 0.30, recoilGain: 1.4 },
  2: { aimError: 0.08,  fireRateMult: 1.4, reactionTime: 0.22, dodgeChance: 0.55, jumpRand: 0.30, speedMult: 1.00, leadMult: 0.70, recoilGain: 1.0 },
  // Skill 3: realistic top-tier — accurate but human (still misses, juke-able).
  // Higher jump tendency makes them visibly play smart; lower aim/reaction
  // gives the player a fair chance even in 1v1.
  3: { aimError: 0.045, fireRateMult: 1.05, reactionTime: 0.16, dodgeChance: 0.75, jumpRand: 0.55, speedMult: 1.05, leadMult: 0.85, recoilGain: 0.85 },
};

let nextBotId = 1;

const NAME_POOLS = ['Russet','Yukon','Idaho','Spudd','Tater','Maris','Kennebec','Fingerling','Bintje','Atlantic','Pontiac','Dauphine','Charlotte','Nicola'];

export class Bot {
  constructor(game, position, team = 'mash') {
    this.id = nextBotId++;
    this.game = game;
    this.team = team;
    // Manual-control flag — true for the DAD player. AI is bypassed in update()
    // when this is set; manualUpdate() runs instead.
    this.manual = false;
    this.manualAimTarget = null;
    this.skill = 3; // all bots maxed — sharp aim, fast reaction, strong dodging
    this.profile = SKILL_PROFILES[this.skill];
    this.name = NAME_POOLS[Math.floor(Math.random() * NAME_POOLS.length)] + ' ' + Math.floor(Math.random() * 90 + 10);

    // Personality — drives chat lines, aggression, help-buddy weight
    this.personality = PERSONALITY_KEYS[Math.floor(Math.random() * PERSONALITY_KEYS.length)];
    this.persona = PERSONALITIES[this.personality];
    this.lastChatTime = 0;
    this.buddy = null;        // assigned post-construction by Game.spawnBot
    this.buddyType = null;    // assigned at pairing — same value for both bots in the pair
    this.idleChatTimer = 12 + Math.random() * 20; // periodic buddy banter

    // TOWER DUTY: ~65% of bots are "tower seekers" at spawn. They prioritize
    // reaching a ladder base and warping up over chasing enemies — once on a
    // platform they drop the flag and behave normally. This is the only way
    // to *guarantee* observable tower use, since combat-engaged bots otherwise
    // never end up near a ladder.
    this.towerDuty = Math.random() < 0.65;
    this.towerDutyTimer = 40 + Math.random() * 25; // seconds before giving up if they can't reach one
    // Slide-dash — bots use a longer, lower-cooldown variant of the player's
    // slide to break LOS and accelerate retreat / push.
    this.slideCooldown = 2.0 + Math.random() * 1.5;
    this.slideTimer = 0;
    this.slideDir = new THREE.Vector3();

    // Sticky target commitment — only switch when forced or major priority shift
    this.committedTarget = null;
    this.targetLostTimer = 0; // seconds without LOS to current committed target

    // Dash — short directional speed burst on cooldown
    this.dashCooldown = 1.5 + Math.random() * 1.5;
    this.dashTimer = 0;       // active dash duration
    this.dashDir = new THREE.Vector3();

    // Tower warp — sniper bots that path to a tower base teleport up the ladder
    this.towerWarpCooldown = 0;
    // After climbing, this gates the bot to HOLD the high ground (no movement
    // until timer expires) instead of immediately walking off the edge.
    this.heightHoldTimer = 0;
    this.position = position.clone();
    this.velocity = new THREE.Vector3();
    this.onGround = true;
    this.dead = false;
    this.kills = 0;
    this.streak = 0;
    this.radius = 0.6;
    this.spawnInvuln = SPAWN_INVULN;

    // Pick combat archetype, then a weapon biased toward that archetype's
    // strengths. The archetype's stat multipliers are later applied on top of
    // any chat-personality multipliers.
    this.archetype = pickArchetype();
    this.archetypeStats = ARCHETYPES[this.archetype];
    this.weaponKey = pickBotWeapon(this.archetype);
    this.weapon = WEAPONS[this.weaponKey];
    this.health = 150;
    this.maxHealth = 150;
    this.timeSinceDamage = 999; // start as if out-of-combat
    this.mag = this.weapon.magSize;
    this.fireCooldown = 0.4 + Math.random() * 1.2;
    this.reloading = false;
    this.reloadTimer = 0;
    this.recoilCharge = 0;
    this.firstSightTime = 0;

    this.path = [];
    this.pathIndex = 0;
    this.repathTimer = Math.random() * 0.5;
    this.target = null;
    this.lastPathGoal = null;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.dodgeCooldown = 0.3;
    this.jumpRandTimer = 1 + Math.random() * 2;

    // Tactical state — set in update()
    this.tacticalState = 'HUNT';
    this.spookedTimer = 0;
    this.lastAttacker = null;
    this.sprinting = false;
    this.coverGoal = null;
    this.coverSearchCooldown = 0;
    this.engageStillTimer = 0; // time spent stopped during ENGAGE — for accuracy
    this.advanceGoal = null;   // strategic forward waypoint when no target visible

    // Lane assignment — splits the team across LEFT / CENTER / RIGHT so they
    // don't all pile onto one side of the map. ID%3 gives roughly even spread.
    // pickAdvanceWaypoint() biases candidate selection toward this lane unless
    // an overrun is detected (see laneIsOverrun()), in which case the bot
    // temporarily shifts to the weaker lane.
    this.homeLane = (this.id % 3) - 1;   // -1 = west, 0 = center, +1 = east
    this.laneSwitchTimer = 0;            // counts down while temporarily off-lane

    // Special-move state — bots use T-equivalent moves on cooldown
    const sp = this.weapon.special;
    // Stagger initial readiness so they don't all pop specials at once
    this.specialCooldown = sp ? sp.cooldown * (0.4 + Math.random() * 0.6) : 0;
    this.specialMod = null;
    this.specialBurstRemaining = 0;
    this.specialBurstGap = 0;
    this.specialBurstTimer = 0;
    this.hotBarrelTimer = 0;

    const tint = this.weapon.viewmodelColor || 0xc47a3d;
    this.mesh = makePotato({ size: 1.5, color: tint });
    this.mesh.position.copy(this.position);
    this.game.scene.add(this.mesh);

    // weapon prop
    const gun = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 0.15, 0.5 + (this.weapon.projectileSize ?? 0.1) * 2),
      new THREE.MeshStandardMaterial({ color: this.weapon.viewmodelColor })
    );
    gun.position.set(0.3, 0, 0.45);
    this.mesh.add(gun);
    this.gunProp = gun;

    // team hat
    const hat = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.55, 0.25, 12),
      new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team] })
    );
    hat.position.y = 1.0;
    this.mesh.add(hat);
    this.teamHat = hat;

    // Bounty crown — glowing spike-cone, only visible on the top-killing bot
    const crownGeo = new THREE.ConeGeometry(0.42, 0.55, 5);
    const crownMat = new THREE.MeshBasicMaterial({ color: 0xffd700, transparent: true, opacity: 0.92 });
    const crown = new THREE.Mesh(crownGeo, crownMat);
    crown.position.y = 1.55;
    crown.visible = false;
    this.mesh.add(crown);
    this.bountyCrown = crown;

    // health bar + name tag
    this.healthBarBg = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 0.18),
      new THREE.MeshBasicMaterial({ color: 0x2a1a0a, depthTest: false })
    );
    this.healthBarFill = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 0.11),
      new THREE.MeshBasicMaterial({ color: TEAM_COLORS[team], depthTest: false })
    );
    this.healthBarBg.renderOrder = 999;
    this.healthBarFill.renderOrder = 1000;
    this.game.scene.add(this.healthBarBg);
    this.game.scene.add(this.healthBarFill);

    // Hot-streak aura — two flat ring meshes at the feet that glow when this
    // bot has 5+ kills in a row. Bigger + more opaque than v1 so you actually
    // notice. Outer team-tinted ring + inner gold ring for hot-streak feel.
    const auraGeo = new THREE.RingGeometry(1.4, 2.1, 40);
    const auraMat = new THREE.MeshBasicMaterial({
      color: TEAM_COLORS[team],
      transparent: true,
      opacity: 0.0,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.aura = new THREE.Mesh(auraGeo, auraMat);
    this.aura.rotation.x = -Math.PI / 2;
    this.aura.visible = false;
    this.game.scene.add(this.aura);
    const auraInnerGeo = new THREE.RingGeometry(0.8, 1.2, 40);
    const auraInnerMat = new THREE.MeshBasicMaterial({
      color: 0xffd700, transparent: true, opacity: 0.0,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this.auraInner = new THREE.Mesh(auraInnerGeo, auraInnerMat);
    this.auraInner.rotation.x = -Math.PI / 2;
    this.auraInner.visible = false;
    this.game.scene.add(this.auraInner);
  }

  // Stable id-string for an enemy used as the team-intel map key.
  intelKey(target) {
    return target === this.game.player ? 'player' : `bot_${target.id}`;
  }

  // Push a chat line to the global chat HUD. Debounced per bot (3s), uses the
  // shared dedup set so teammates don't echo the same wording on screen. If
  // the bot has a buddyType and the event has buddy-flavored lines for that
  // type, those override the personality bank — so the WW2 roleplay-guy
  // always sounds like the WW2 roleplay-guy. Tags game.lastChatEvent so
  // teammates can reply contextually.
  emitChat(event) {
    const now = performance.now() / 1000;
    if (now - this.lastChatTime < 3) return;
    this.lastChatTime = now;
    let line = null;
    if (this.buddyType && BUDDY_LINES[this.buddyType] && BUDDY_LINES[this.buddyType][event]) {
      const bank = BUDDY_LINES[this.buddyType][event];
      const used = this.game && this.game.usedChatLines ? this.game.usedChatLines : null;
      const fresh = used ? bank.filter((l) => !used.has(lineKey(l))) : bank;
      const pool = (fresh && fresh.length > 0) ? fresh : bank;
      line = pool[Math.floor(Math.random() * pool.length)];
    } else {
      line = pickLineDedup(event, this.personality, this.game);
    }
    if (this.game.addChatMessage) this.game.addChatMessage(this, line);
    // Tag this event so teammates can react to it (used by tryReplyToLast).
    this.game.lastChatEvent = {
      speaker: this,
      event,
      team: this.team,
      time: now,
    };
  }

  // Reply to the most recent chat message from a teammate. Picks a reply line
  // contextual to the prior event (e.g. "got you" after a lowHp call).
  // Skips if there's no recent event, it was our own line, or it was an enemy.
  tryReplyToLast() {
    const last = this.game && this.game.lastChatEvent;
    if (!last) return false;
    const now = performance.now() / 1000;
    if (now - last.time > 6.5) return false;       // too stale
    if (last.speaker === this) return false;       // don't reply to self
    if (last.team !== this.team) return false;     // don't reply to enemies
    const bankKey = replyBankFor(last.event);
    const bank = (CHAT_REPLIES[bankKey] && CHAT_REPLIES[bankKey][this.personality]) || null;
    if (!bank || bank.length === 0) return false;
    if (now - this.lastChatTime < 3) return false;
    this.lastChatTime = now;
    const used = this.game.usedChatLines ? this.game.usedChatLines : null;
    const fresh = used ? bank.filter((l) => !used.has(lineKey(l))) : bank;
    const pool = (fresh && fresh.length > 0) ? fresh : bank;
    const line = pool[Math.floor(Math.random() * pool.length)];
    if (this.game.addChatMessage) this.game.addChatMessage(this, line);
    // Clear the prior event so multiple teammates don't all pile on with replies
    this.game.lastChatEvent = null;
    return true;
  }

  // Snap to the top of a ladder when this bot is near the base. Snipers warp
  // up aggressively; other bots warp up whenever they happen to pass near one,
  // so all bots actually exploit high ground. Cooldowns keep it from looking
  // like teleport spam.
  tryTowerWarp(dt) {
    if (this.towerWarpCooldown > 0) {
      this.towerWarpCooldown = Math.max(0, this.towerWarpCooldown - dt);
      return;
    }
    if (!this.game.arena.ladders) return;
    const isSniper = this.weaponKey === 'boomstick';
    // Three priority lanes:
    //   1) towerDuty bots ALWAYS climb whenever near a ladder (no random skip).
    //   2) Non-duty snipers only warp when their goal is a high spot.
    //   3) Non-duty regular bots roll 85% to climb when they pass a ladder.
    if (this.towerDuty) {
      if (this.position.y > 5.5) return;
    } else if (isSniper) {
      if (!this.advanceGoal && !this.coverGoal) return;
      const goal = this.coverGoal || this.advanceGoal;
      const isHighGoal = Math.abs(goal.x) > 55 || (Math.abs(goal.x) < 8 && Math.abs(goal.z) < 8);
      if (!isHighGoal) return;
    } else {
      // Regular bots: opportunistic climb. 40% chance — boosted from 15%
      // because the user wants visibly more outpost use for high-ground play.
      if (this.position.y > 5.5) return;
      if (Math.random() < 0.60) return;
    }
    for (const lad of this.game.arena.ladders) {
      const dx = this.position.x - lad.x;
      const dz = this.position.z - lad.z;
      if (Math.hypot(dx, dz) < 2.8) {
        // Animate the climb a little instead of instant teleport: we still
        // snap-place, but the cooldown gates re-use so it reads as "they
        // climbed up". Add a brief vertical hop so the eye catches it.
        this.position.y = lad.top + 0.85;
        this.velocity.y = 2;
        this.onGround = false;
        this.towerWarpCooldown = isSniper ? 6 : 14;
        // Hold the high ground for several seconds so the bot actually USES
        // the elevation (fires from up here) instead of immediately walking
        // off the edge. Snipers hold longer.
        this.heightHoldTimer = isSniper ? 18 + Math.random() * 8 : 10 + Math.random() * 6;
        this.advanceGoal = null;
        this.coverGoal = null;
        this.path = [];
        this.pathIndex = 0;
        // Chat: occasional "I'm on the tower" callout when a non-sniper climbs
        if (!isSniper && Math.random() < 0.35) this.emitChat('highGround');
        return;
      }
    }
  }

  // Push our current target's position to the team intel map.
  broadcastIntel(target) {
    if (!target) return;
    this.game.teamIntel[this.team].set(this.intelKey(target), {
      pos: target.position.clone(),
      time: Date.now(),
    });
  }

  // Most recent fresh intel from teammates (for advance/flank goals).
  getFreshTeamIntel() {
    const intel = this.game.teamIntel[this.team];
    let best = null, bestTime = 0;
    const cutoff = Date.now() - INTEL_FRESH_MS;
    for (const entry of intel.values()) {
      if (entry.time < cutoff) continue;
      if (entry.time > bestTime) { bestTime = entry.time; best = entry; }
    }
    return best;
  }

  pickTarget() {
    const candidates = [];
    if (!this.game.player.dead && this.game.player.team !== this.team) candidates.push(this.game.player);
    for (const b of this.game.bots) {
      if (b !== this && !b.dead && b.team !== this.team) candidates.push(b);
    }
    // Remote multiplayer player counts as an enemy if they're on the opposite team
    const remote = this.game.remotePlayer;
    if (remote && !remote.dead && remote.team !== this.team) candidates.push(remote);
    if (candidates.length === 0) return null;

    // ----- Target commitment -----
    // Stick to the committed target unless: it's dead, we've lost LOS for >2.5s,
    // or a candidate is dramatically more valuable (e.g. very close + low HP).
    const committed = this.committedTarget;
    if (committed && !committed.dead && candidates.includes(committed)) {
      const losToCommitted = this.hasLineOfSight(committed.position, committed === this.game.player ? 1.5 : 1.0);
      if (losToCommitted) this.targetLostTimer = 0;
      // If we still have LOS or recently lost it, keep aiming at the same person.
      if (this.targetLostTimer < 2.5) {
        // BUT: if our buddy is being attacked by a candidate and we have spare attention,
        // switch to defend. Same for "bigger threat" — Most Wanted with very high kills.
        const buddyAttacker = this.buddy && !this.buddy.dead && this.buddy.lastAttacker
          && !this.buddy.lastAttacker.dead && candidates.includes(this.buddy.lastAttacker)
          ? this.buddy.lastAttacker : null;
        if (buddyAttacker && Math.random() < this.persona.helpBuddy * 0.5) {
          this.committedTarget = buddyAttacker;
          this.targetLostTimer = 0;
          return buddyAttacker;
        }
        return committed;
      }
    }

    const teamIntel = this.game.teamIntel[this.team];
    const now = Date.now();
    // Compute "Most Wanted" — the highest-killing enemy. If their kill count is
    // strong, weight them heavily so the team converges instead of trickling.
    let topKills = 1;
    let mostWanted = null;
    for (const c of candidates) {
      const k = c.kills || 0;
      if (k > topKills) { topKills = k; mostWanted = c; }
    }
    let best = null, bestScore = Infinity;
    for (const c of candidates) {
      const d = c.position.distanceTo(this.position);
      const los = this.hasLineOfSight(c.position, c === this.game.player ? 1.5 : 1.0);
      const intel = teamIntel.get(this.intelKey(c));
      const intelBonus = (intel && now - intel.time < 2500) ? 0.7 : 1.0;
      const hp = c.health ?? 100;
      const maxHp = c.maxHealth ?? 100;
      const woundedBonus = hp < maxHp * 0.45 ? 0.55 : (hp < maxHp * 0.75 ? 0.8 : 1.0);
      // Most Wanted bonus — drops score (= more attractive) for the top killer
      let wantedBonus = 1.0;
      if (mostWanted && c === mostWanted && (c.kills || 0) >= 3) {
        wantedBonus = 0.45;
      }
      // High-ground sniper bonus — enemy boomstick wielder perched on a tower
      // is the top priority for the team; drops score to ~1/3.
      let sniperBonus = 1.0;
      const candidateWeapon = c.weaponKey || c.currentWeapon;
      const candidateY = c.position ? c.position.y : 0;
      if (candidateWeapon === 'boomstick' && candidateY > 5) {
        sniperBonus = 0.35;
      } else if (candidateWeapon === 'boomstick') {
        sniperBonus = 0.7; // even on the ground, snipers are dangerous
      }
      // Buddy assist — if my buddy is engaging this candidate, prefer it
      let buddyBonus = 1.0;
      if (this.buddy && !this.buddy.dead && this.buddy.committedTarget === c) {
        buddyBonus = 1 - 0.25 * Math.min(1, this.persona.helpBuddy);
      }
      const score = d * (los ? 1 : 2.5) * intelBonus * woundedBonus * wantedBonus * sniperBonus * buddyBonus;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (best && best !== committed) {
      this.committedTarget = best;
      this.targetLostTimer = 0;
    }
    return best;
  }

  hasLineOfSight(targetPos, targetEyeOffset = 1.0) {
    const from = this.position.clone(); from.y += 0.4;
    const to = targetPos.clone(); to.y += targetEyeOffset;
    const dir = new THREE.Vector3().subVectors(to, from);
    const dist = dir.length();
    if (dist < 0.01) return true;
    dir.normalize();
    const stepSize = 0.8;
    const steps = Math.ceil(dist / stepSize);
    for (let i = 1; i < steps; i++) {
      const t = (i * stepSize) / dist;
      const pt = from.clone().lerp(to, t);
      for (const obs of this.game.arena.obstacles) {
        const cx = obs.x + obs.w / 2;
        const cz = obs.z + obs.d / 2;
        if (
          Math.abs(pt.x - cx) < obs.w / 2 &&
          Math.abs(pt.z - cz) < obs.d / 2 &&
          pt.y > obs.y && pt.y < obs.y + obs.h
        ) return false;
      }
    }
    return true;
  }

  requestPath(target) {
    if (!target) { this.path = []; this.pathIndex = 0; return; }
    let gx = target.position.x;
    let gz = target.position.z;

    // Lateral flanking for long-range approaches: don't run head-on. Even-id
    // bots flank right, odd-id bots flank left, so a squad converges from both
    // sides instead of stacking up behind cover.
    const dx = gx - this.position.x;
    const dz = gz - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 18) {
      const nx = dx / dist, nz = dz / dist;
      const px = -nz, pz = nx; // perpendicular
      const flankSign = (this.id % 2 === 0) ? 1 : -1;
      const flankDist = Math.min(12, dist * 0.35);
      const drop = Math.min(4, dist * 0.15);
      gx = target.position.x - nx * drop + px * flankSign * flankDist;
      gz = target.position.z - nz * drop + pz * flankSign * flankDist;
    }

    // If the goal lands inside the enemy spawn zone (their safe area —
    // forbidden to us), aim for the nearest edge just outside it.
    const enemyTeam = this.team === 'mash' ? 'russet' : 'mash';
    const zone = this.game.arena.teamSpawnZones[enemyTeam];
    if (zone && gx > zone.minX && gx < zone.maxX && gz > zone.minZ && gz < zone.maxZ) {
      const dMinX = gx - zone.minX;
      const dMaxX = zone.maxX - gx;
      const dMinZ = gz - zone.minZ;
      const dMaxZ = zone.maxZ - gz;
      const m = Math.min(dMinX, dMaxX, dMinZ, dMaxZ);
      const pad = this.radius + 0.1;
      if (m === dMinX) gx = zone.minX - pad;
      else if (m === dMaxX) gx = zone.maxX + pad;
      else if (m === dMinZ) gz = zone.minZ - pad;
      else gz = zone.maxZ + pad;
    }
    const p = this.game.navGrid.findPath(
      this.position.x, this.position.z,
      gx, gz
    );
    if (p && p.length > 0) {
      this.path = p;
      this.pathIndex = 0;
      this.lastPathGoal = target.position.clone();
    } else {
      this.path = [];
      this.pathIndex = 0;
    }
  }

  // Pick a forward strategic waypoint when no enemy is visible. This is the
  // anti-base-camp lever: bots always have somewhere to be moving toward.
  // Snipers (Masher) get a high-ground biased waypoint table so they head for
  // towers and watchtower instead of skirmishing in mid-field.
  pickAdvanceWaypoint() {
    // Recompute lane every ~2s — gives us a chance to detect a side getting
    // overrun and rebalance. Result is stored on `this.activeLane` (default to
    // homeLane).
    this.activeLane = this.computeActiveLane();

    // Step 1: do we have fresh team intel? Converge on the enemy with a flank.
    // Only ~half the squad converges on a given sighting — the rest stay on
    // their assigned lane so we don't drain the other lanes when contact is
    // made on one side.
    const intel = this.getFreshTeamIntel();
    const intelSideMatchesLane = intel && Math.sign(intel.pos.x || 0.0001) === Math.sign(this.activeLane || 0.0001);
    const allowConverge = intelSideMatchesLane || (this.id % 4 < 2); // ~50% of bots converge cross-lane
    if (intel && allowConverge) {
      const dx = intel.pos.x - this.position.x;
      const dz = intel.pos.z - this.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1) {
        const nx = dx / dist, nz = dz / dist;
        const px = -nz, pz = nx;
        const flankSign = (this.id % 2 === 0) ? 1 : -1;
        const flankDist = Math.min(14, dist * 0.45);
        const drop = Math.min(6, dist * 0.25);
        return new THREE.Vector3(
          intel.pos.x - nx * drop + px * flankSign * flankDist,
          0,
          intel.pos.z - nz * drop + pz * flankSign * flankDist,
        );
      }
    }

    // Step 2: no intel — pick from the strategic waypoint table.
    const enemyZ = this.team === 'mash' ? -45 : 45;
    const isSniper = this.weaponKey === 'boomstick';
    const candidates = isSniper ? [
      // Snipers hard-stick to high ground: ~95% tower/platform, ~5% roam.
      { x: 0,    z: 0,                weight: 8 }, // watchtower hill (top high ground)
      { x: 62,   z: 0,                weight: 6 }, // east tower
      { x: -62,  z: 0,                weight: 6 }, // west tower
      { x: -36,  z: 36,               weight: 3 }, // archer platform
      { x: 32,   z: -32,              weight: 3 }, // tavern 2nd floor
      { x: 32,   z: 32,               weight: 5 }, // NE outpost top — sniper perch
      { x: -44,  z: -36,              weight: 5 }, // SW outpost top — sniper perch
      { x: 44,   z: 44,               weight: 4 }, // far NE outpost top
      { x: -32,  z: 28,               weight: 4 }, // NW outpost top
      { x: 36,   z: -40,              weight: 4 }, // SE outpost top
      { x:  18,  z:  18,              weight: 4 }, // N-east catwalk
      { x: -18,  z:  18,              weight: 4 }, // N-west catwalk
      { x:  18,  z: -18,              weight: 4 }, // S-east catwalk
      { x: -18,  z: -18,              weight: 4 }, // S-west catwalk
      { x: (Math.random() - 0.5) * 50, z: enemyZ * 0.4, weight: 1.4 }, // occasional roam (~5%)
    ] : [
      // Non-sniper waypoints point at LADDER BASES (south side of each tower
      // structure), so the pathfinder walks the bot right up to the ladder and
      // tryTowerWarp() fires the climb. Walkable hill/catwalk tops stay as-is.
      { x: 0,    z: 0,     weight: 5 }, // central watchtower (walkable hill)
      { x: 62,   z: 4.7,   weight: 5 }, // east square tower ladder base
      { x: -62,  z: 5.2,   weight: 5 }, // west square tower ladder base
      { x: 32,   z: 34.7,  weight: 5 }, // NE outpost ladder base
      { x: -44,  z: -33.8, weight: 5 }, // SW outpost ladder base
      { x: 44,   z: 46.7,  weight: 4 }, // far NE outpost ladder base
      { x: -32,  z: 30.7,  weight: 4 }, // NW outpost ladder base
      { x: 36,   z: -37.8, weight: 4 }, // SE outpost ladder base
      { x: -36,  z: 32,    weight: 2 }, // archer platform stair base (south)
      { x: 32,   z: -28,   weight: 2 }, // tavern stair base (south)
      { x:  18,  z:  18,   weight: 3 }, // N-east catwalk (walkable solid deck)
      { x: -18,  z:  18,   weight: 3 }, // N-west catwalk
      { x:  18,  z: -18,   weight: 3 }, // S-east catwalk
      { x: -18,  z: -18,   weight: 3 }, // S-west catwalk
      { x: (Math.random() - 0.5) * 50, z: enemyZ * 0.6, weight: 3 }, // mid-forward random
      { x: (Math.random() - 0.5) * 70, z: enemyZ,       weight: 2 }, // deep forward random
    ];
    // Lane bias: triple the weight of candidates whose x matches our active
    // lane (-1 = west, 0 = center, +1 = east), and zero out candidates on the
    // far opposite side. Result: bots spread across left/center/right instead
    // of all funneling to the same hotspot.
    const lane = this.activeLane ?? this.homeLane ?? 0;
    const inLane = (x) => {
      if (lane === 0) return Math.abs(x) <= 30;
      if (lane < 0) return x <= 10;       // west bots accept center + west
      return x >= -10;                     // east bots accept center + east
    };
    const onFarOpposite = (x) => {
      if (lane === 0) return false;
      return lane > 0 ? x < -30 : x > 30;
    };
    const weighted = candidates.map((c) => {
      if (onFarOpposite(c.x)) return { ...c, weight: 0 };
      if (inLane(c.x))         return { ...c, weight: c.weight * 3 };
      return c;
    });
    const total = weighted.reduce((s, c) => s + c.weight, 0);
    if (total <= 0) {
      // fallback in case all candidates were filtered out
      const c = candidates[Math.floor(Math.random() * candidates.length)];
      return new THREE.Vector3(c.x, 0, c.z);
    }
    let r = Math.random() * total;
    for (const c of weighted) {
      r -= c.weight;
      if (r <= 0) return new THREE.Vector3(c.x, 0, c.z);
    }
    return new THREE.Vector3(0, 0, 0);
  }

  // Decide which lane this bot should currently work. Defaults to homeLane,
  // but if our lane has noticeably more friendly bots than another lane (and
  // that other lane is sparsely defended), we temporarily switch to balance.
  // "About to be overrun" = enemy team has 2+ more bots on a lane than we do.
  computeActiveLane() {
    const teamBots = this.game.bots.filter((b) => !b.dead && b.team === this.team);
    const enemyBots = this.game.bots.filter((b) => !b.dead && b.team !== this.team);
    const laneOf = (b) => Math.abs(b.position.x) <= 30 ? 0 : (b.position.x > 0 ? 1 : -1);
    const counts = (arr) => {
      const c = { '-1': 0, '0': 0, '1': 0 };
      for (const b of arr) c[laneOf(b)]++;
      return c;
    };
    const friendly = counts(teamBots);
    const enemy = counts(enemyBots);
    // Pressure: how many extra enemies vs friendlies on each lane.
    const pressure = {
      '-1': enemy['-1'] - friendly['-1'],
      '0':  enemy['0']  - friendly['0'],
      '1':  enemy['1']  - friendly['1'],
    };
    // If any lane is being overrun (pressure ≥ 2) AND has > pressure than our
    // home lane, we shift there.
    let worstLane = this.homeLane;
    let worstPressure = pressure[String(this.homeLane)];
    for (const lane of [-1, 0, 1]) {
      if (pressure[String(lane)] >= 2 && pressure[String(lane)] > worstPressure) {
        worstPressure = pressure[String(lane)];
        worstLane = lane;
      }
    }
    return worstLane;
  }

  // Pick a flee point: away from current threat, biased toward our team's keep.
  // Bots only use this as a LAST RESORT — see findHealthCrate/findCoverWaypoint.
  fleeWaypoint() {
    const threat = this.lastAttacker && !this.lastAttacker.dead ? this.lastAttacker : this.target;
    if (!threat) return null;
    const dir = new THREE.Vector3().subVectors(this.position, threat.position);
    dir.y = 0;
    if (dir.lengthSq() < 0.01) dir.set(1, 0, 0);
    dir.normalize();
    // Try a point ~16m in flee direction, then nudge toward our home keep
    const flee = this.position.clone().addScaledVector(dir, 16);
    const home = this.team === 'mash' ? new THREE.Vector3(0, 0, 80) : new THREE.Vector3(0, 0, -80);
    flee.lerp(home, 0.25);
    const B = this.game.arena.bounds - 6;
    flee.x = Math.max(-B, Math.min(B, flee.x));
    flee.z = Math.max(-B, Math.min(B, flee.z));
    return flee;
  }

  // Find the nearest available health pickup. Returns its position or null.
  // Only considers pickups within a sane distance — running cross-map for a
  // health crate is worse than just hunkering down in cover.
  findHealthCrate() {
    if (!this.game.pickups) return null;
    let best = null, bestD = 28;
    for (const pk of this.game.pickups) {
      if (!pk || pk.taken || pk._disposed) continue;
      if (pk.type !== 'health') continue;
      const d = pk.basePos.distanceTo(this.position);
      if (d < bestD) { bestD = d; best = pk; }
    }
    return best ? best.basePos.clone() : null;
  }

  // Find the nearest available ammo crate.
  findAmmoCrate() {
    if (!this.game.pickups) return null;
    let best = null, bestD = 22;
    for (const pk of this.game.pickups) {
      if (!pk || pk.taken || pk._disposed) continue;
      if (pk.type !== 'ammo') continue;
      const d = pk.basePos.distanceTo(this.position);
      if (d < bestD) { bestD = d; best = pk; }
    }
    return best ? best.basePos.clone() : null;
  }

  // Walk-over pickup collection — bots get the same crate benefits as the player.
  // Heals when stepping on a health crate, refills ammo on ammo crate.
  tryCollectPickups() {
    if (!this.game.pickups) return;
    for (const pk of this.game.pickups) {
      if (!pk || pk.taken || pk._disposed) continue;
      if (pk.type !== 'health' && pk.type !== 'ammo') continue;
      const d = pk.basePos.distanceTo(this.position);
      if (d > 1.8) continue;
      if (pk.type === 'health') {
        if (this.health >= this.maxHealth) continue;
        this.health = Math.min(this.maxHealth, this.health + 50);
      } else if (pk.type === 'ammo') {
        if (this.mag >= this.weapon.magSize) continue;
        this.mag = this.weapon.magSize;
      }
      pk.taken = true;
      pk.respawnAt = performance.now() / 1000 + 12;
      if (pk.mesh) pk.mesh.visible = false;
    }
  }

  // Bot slide-dash — like player slide but auto-triggers in tactical situations.
  // 0.45s of ~2.6× speed in the given direction, 4-5s cooldown.
  triggerSlide(dir) {
    if (this.slideCooldown > 0 || this.slideTimer > 0) return;
    if (!dir || dir.lengthSq() < 0.001) return;
    this.slideDir.copy(dir).setY(0).normalize();
    this.slideTimer = 0.45;
    this.slideCooldown = 4.0 + Math.random() * 1.5;
  }

  // Find a nearby obstacle that breaks LOS to the target — pick a position
  // tucked behind it so we can safely heal up or peek.
  findCoverWaypoint() {
    if (!this.target) return null;
    const tp = this.target.position;
    let best = null, bestScore = Infinity;
    for (const obs of this.game.arena.obstacles) {
      const obsTop = obs.y + obs.h;
      if (obsTop < 1.6) continue;            // too short to hide behind
      if (obsTop > 8) continue;              // walls/towers — fine for cover, but skip giant blocks beyond use
      const cx = obs.x + obs.w / 2;
      const cz = obs.z + obs.d / 2;
      const distToObs = Math.hypot(cx - this.position.x, cz - this.position.z);
      if (distToObs < 2 || distToObs > 22) continue;
      // Cover position is on the far side of the obstacle from the target
      const away = new THREE.Vector3(cx - tp.x, 0, cz - tp.z);
      if (away.lengthSq() < 0.01) continue;
      away.normalize();
      const offset = Math.max(obs.w, obs.d) / 2 + 1.2;
      const cover = new THREE.Vector3(cx + away.x * offset, 0, cz + away.z * offset);
      const distSelf = Math.hypot(cover.x - this.position.x, cover.z - this.position.z);
      if (distSelf > 18) continue;
      const score = distSelf + distToObs * 0.3; // prefer closer cover
      if (score < bestScore) { bestScore = score; best = cover; }
    }
    return best;
  }

  // Resolve a single obstacle pass against newPos for one axis only. Called in
  // a loop over sub-steps so high-speed travel doesn't tunnel thin walls.
  resolveBotCollisionAxis(pos, axis) {
    const botBottom = this.position.y - 0.85;
    const botTop = this.position.y + 0.85;
    for (const obs of this.game.arena.obstacles) {
      const obsTop = obs.y + obs.h;
      const obsBot = obs.y;
      if (obsTop <= botBottom + 0.1) continue;
      if (obsBot >= botTop - 0.1) continue;
      const cx = obs.x + obs.w / 2;
      const cz = obs.z + obs.d / 2;
      const halfW = obs.w / 2 + this.radius;
      const halfD = obs.d / 2 + this.radius;
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      if (Math.abs(dx) >= halfW) continue;
      if (Math.abs(dz) >= halfD) continue;
      if (axis === 'x') pos.x = cx + Math.sign(dx || 1) * halfW;
      else              pos.z = cz + Math.sign(dz || 1) * halfD;
      if (this.repathTimer > 0.3) this.repathTimer = 0.2;
    }
  }

  // Follow current path: write desired XZ direction into outDir
  followPath(outDir) {
    if (this.path.length > 0 && this.pathIndex < this.path.length) {
      const wp = this.path[this.pathIndex];
      const dx = wp.x - this.position.x;
      const dz = wp.z - this.position.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d < 0.7) this.pathIndex++;
      else if (d > 0.001) outDir.set(dx / d, 0, dz / d);
    }
  }

  // Trigger a dash burst — 0.18s of ~3× speed in `dir`. 4-5s cooldown.
  triggerDash(dir) {
    if (this.dashCooldown > 0 || this.dashTimer > 0) return;
    if (!dir || dir.lengthSq() < 0.001) return;
    this.dashDir.copy(dir).setY(0).normalize();
    this.dashTimer = 0.18;
    this.dashCooldown = 4 + Math.random() * 1.5;
  }

  // detect incoming enemy projectiles and dodge by jumping or flipping strafe
  tryDodge(dt) {
    this.dodgeCooldown -= dt;
    if (this.dodgeCooldown > 0) return;
    for (const p of this.game.projectiles) {
      if (p.dead) continue;
      if (p.ownerTeam === this.team) continue;
      const toUs = new THREE.Vector3().subVectors(this.position, p.position);
      const dist = toUs.length();
      if (dist > 14 || dist < 0.5) continue;
      const speed = p.velocity.length();
      if (speed < 1) continue;
      const projDir = p.velocity.clone().divideScalar(speed);
      const dotToUs = toUs.divideScalar(dist).dot(projDir);
      if (dotToUs < 0.92) continue; // not aimed at us
      const tti = dist / speed;
      if (tti > 0.7 || tti < 0.04) continue;
      const archDodge = this.archetypeStats?.dodgeMult ?? 1;
      if (Math.random() < this.profile.dodgeChance * this.persona.dodgeMult * archDodge) {
        // 40% jump, 30% flip strafe, 30% dash sideways — feels more alive
        const choice = Math.random();
        if (choice < 0.4 && this.onGround) {
          this.velocity.y = JUMP_VEL;
          this.onGround = false;
        } else if (choice < 0.7) {
          this.strafeDir = -this.strafeDir;
        } else if (this.dashCooldown <= 0) {
          // dash perpendicular to incoming projectile
          const perp = new THREE.Vector3(-projDir.z, 0, projDir.x);
          if (Math.random() < 0.5) perp.multiplyScalar(-1);
          this.triggerDash(perp);
        }
      }
      this.dodgeCooldown = 0.45 + Math.random() * 0.35;
      return;
    }
  }

  update(dt) {
    if (this.dead) return;
    if (this.manual) { this.manualUpdate(dt); return; }
    const w = this.weapon;
    const prof = this.profile;

    if (this.spawnInvuln > 0) this.spawnInvuln -= dt;
    if (this.spookedTimer > 0) this.spookedTimer -= dt;
    if (this.heightHoldTimer > 0) this.heightHoldTimer -= dt;
    if (this.coverSearchCooldown > 0) this.coverSearchCooldown -= dt;
    if (this.specialCooldown > 0) this.specialCooldown -= dt;
    if (this.hotBarrelTimer > 0) this.hotBarrelTimer -= dt;
    if (this.specialBurstRemaining > 0) this.specialBurstTimer -= dt;
    if (this.slideCooldown > 0) this.slideCooldown -= dt;
    if (this.slideTimer > 0) this.slideTimer -= dt;

    // Walk-over crate collection — heals or refills ammo when stepping over a pickup
    this.tryCollectPickups();

    // Out-of-combat regen — same 1 HP/sec drip the player uses
    this.timeSinceDamage += dt;
    if (this.timeSinceDamage > 4.0 && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + 1 * dt);
    }

    // pick target
    const prevTarget = this.target;
    this.target = this.pickTarget();
    if (this.target && this.target !== prevTarget) {
      this.firstSightTime = prof.reactionTime;
    }
    // bookkeep target-lost timer for commitment logic
    if (this.committedTarget && !this.hasLineOfSight(this.committedTarget.position, this.committedTarget === this.game.player ? 1.5 : 1.0)) {
      this.targetLostTimer += dt;
    }

    // Tower warp for snipers (mandatory high-ground)
    this.tryTowerWarp(dt);

    // Dash cooldown / active dash
    if (this.dashCooldown > 0) this.dashCooldown -= dt;
    if (this.dashTimer > 0) this.dashTimer -= dt;

    // distance + LOS to target
    let targetDist = Infinity;
    let hasLos = false;
    if (this.target) {
      targetDist = this.target.position.distanceTo(this.position);
      hasLos = this.hasLineOfSight(this.target.position, this.target === this.game.player ? 1.5 : 1.0);
      // Broadcast: when we can see them, our team can see them.
      if (hasLos) this.broadcastIntel(this.target);
    }

    // ----- tactical state -----
    const range = (WEAPON_RANGE[this.weaponKey] || 25) * (this.archetypeStats?.rangeBias || 1);
    let state = 'HUNT';
    if (this.target) {
      // Tactical cascade: deep wounds break to cover/health; light wounds use
      // PEEK (re-engage from cover); otherwise normal engage/hunt.
      // Thresholds are RELATIVE to maxHealth so they scale with health caps.
      if (this.health < this.maxHealth * 0.22)            state = 'FLEE';
      else if (this.health < this.maxHealth * 0.40 && hasLos) state = 'PEEK';
      else if (this.spookedTimer > 0 && hasLos)           state = 'PEEK';
      else if (hasLos && targetDist <= range)             state = 'ENGAGE';
      else                                                state = 'HUNT';
    }
    // Tower duty hijacks ENGAGE: keep walking toward the ladder even if we
    // have a clean engagement. Bot still fires while moving (state machine
    // below picks targets; we only force the move-direction branch).
    if (this.towerDuty && this.position.y < 5 && state === 'ENGAGE') {
      state = 'HUNT';
    }
    this.tacticalState = state;

    // ----- pick path goal based on state -----
    let goalPos = null;
    if (state === 'FLEE' || state === 'PEEK') {
      if (!this.coverGoal || this.coverSearchCooldown <= 0) {
        let cand = null;
        // FLEE priority cascade: nearby health crate → cover behind obstacle →
        // (last resort) flee toward home keep. The crate-and-cover path keeps
        // the bot in the fight instead of bee-lining back to spawn.
        if (state === 'FLEE') {
          cand = this.findHealthCrate();
          if (!cand) cand = this.findCoverWaypoint();
          if (!cand) cand = this.fleeWaypoint();
        } else {
          // PEEK: break LOS via cover, fall back to flee direction
          cand = this.findCoverWaypoint();
          if (!cand) cand = this.fleeWaypoint();
        }
        if (cand) {
          this.coverGoal = cand;
          this.coverSearchCooldown = 1.5;
        }
      }
      goalPos = this.coverGoal;
      // Burst slide-dash away from threat to break LOS faster
      if (this.slideCooldown <= 0 && this.target && this.coverGoal) {
        const fleeDir = new THREE.Vector3().subVectors(this.coverGoal, this.position);
        fleeDir.y = 0;
        if (fleeDir.lengthSq() > 1) {
          fleeDir.normalize();
          if (Math.random() < 0.08) this.triggerSlide(fleeDir);
        }
      }
    } else {
      this.coverGoal = null;
      if (this.target) {
        goalPos = this.target.position;
        this.advanceGoal = null;
      } else {
        // No target — push forward toward strategic waypoints (anti-camp).
        // Tighter completion threshold (was 6, now 2.5) so bots actually
        // arrive at the ladder XZ before re-rolling the waypoint.
        if (!this.advanceGoal || this.position.distanceTo(this.advanceGoal) < 2.5) {
          this.advanceGoal = this.pickAdvanceWaypoint();
        }
        goalPos = this.advanceGoal;
      }
    }

    // TOWER DUTY override: while flagged, the bot heads to the nearest ladder
    // base regardless of state. Cleared once they're up (y > 5) or the timer
    // expires. They still pick targets and fire — only movement is redirected.
    if (this.towerDuty) {
      this.towerDutyTimer -= dt;
      if (this.position.y > 5 || this.towerDutyTimer <= 0) {
        this.towerDuty = false;
      } else if (this.game.arena.ladders && this.game.arena.ladders.length) {
        // Find nearest ladder. Bias slightly toward ladders forward of our
        // home side so duty bots actually push the line.
        let nearest = null, nd = Infinity;
        for (const lad of this.game.arena.ladders) {
          const dx = this.position.x - lad.x;
          const dz = this.position.z - lad.z;
          const d = dx * dx + dz * dz;
          if (d < nd) { nd = d; nearest = lad; }
        }
        if (nearest) {
          if (!this.advanceGoal
              || Math.abs(this.advanceGoal.x - nearest.x) > 0.8
              || Math.abs(this.advanceGoal.z - nearest.z) > 0.8) {
            this.advanceGoal = new THREE.Vector3(nearest.x, 0, nearest.z);
            this.path = []; this.pathIndex = 0;
            this.repathTimer = 0;
          }
          goalPos = this.advanceGoal;
        }
      }
    }

    // Periodic chat tick — first chance is a context reply to a teammate's
    // recent line; otherwise falls back to buddy idle banter.
    this.idleChatTimer -= dt;
    if (this.idleChatTimer <= 0) {
      this.idleChatTimer = 18 + Math.random() * 24;
      if (!this.tryReplyToLast()) {
        if (this.buddy && !this.buddy.dead && this.buddyType) {
          this.emitChat('idle');
        }
      }
    }

    // Faster reply window — if a teammate spoke very recently AND has tagged
    // an event we care about (lowHp, bounty, death), eagerly chime in without
    // waiting for the slow idle timer. Keeps chat feeling conversational.
    if (this.game.lastChatEvent
        && this.game.lastChatEvent.speaker !== this
        && this.game.lastChatEvent.team === this.team
        && performance.now() / 1000 - this.game.lastChatEvent.time < 1.6) {
      const ev = this.game.lastChatEvent.event;
      if ((ev === 'lowHp' || ev === 'death' || ev === 'buddyDown' || ev === 'bounty') && Math.random() < 0.04) {
        this.tryReplyToLast();
      }
    }

    // ----- repath -----
    this.repathTimer -= dt;
    const needsRepath =
      this.repathTimer <= 0 ||
      this.pathIndex >= this.path.length ||
      (goalPos && this.lastPathGoal && goalPos.distanceTo(this.lastPathGoal) > 3);
    if (goalPos && needsRepath) {
      if (this.coverGoal) {
        const p = this.game.navGrid.findPath(this.position.x, this.position.z, this.coverGoal.x, this.coverGoal.z);
        if (p && p.length > 0) {
          this.path = p;
          this.pathIndex = 0;
          this.lastPathGoal = this.coverGoal.clone();
        } else {
          this.path = []; this.pathIndex = 0;
        }
      } else if (this.towerDuty && this.advanceGoal) {
        // Tower duty: path directly to the ladder, ignoring any combat target.
        const p = this.game.navGrid.findPath(this.position.x, this.position.z, this.advanceGoal.x, this.advanceGoal.z);
        if (p && p.length > 0) {
          this.path = p;
          this.pathIndex = 0;
          this.lastPathGoal = this.advanceGoal.clone();
        } else {
          // Path failed — drop the duty so the bot doesn't stand still forever
          this.towerDuty = false;
          this.path = []; this.pathIndex = 0;
        }
      } else if (this.target) {
        this.requestPath(this.target);
      } else if (this.advanceGoal) {
        const p = this.game.navGrid.findPath(this.position.x, this.position.z, this.advanceGoal.x, this.advanceGoal.z);
        if (p && p.length > 0) {
          this.path = p;
          this.pathIndex = 0;
          this.lastPathGoal = this.advanceGoal.clone();
        } else {
          // Goal unreachable — pick a different one next frame
          this.advanceGoal = null;
          this.path = []; this.pathIndex = 0;
        }
      }
      this.repathTimer = 0.7 + Math.random() * 0.5;
    }

    // dodge incoming projectiles (still useful at close range)
    this.tryDodge(dt);

    // Random hop — visibly active even mid-engage so they're juke-able.
    // Higher jump in LOW GRAVITY frenzy so bots match player vertical mobility.
    this.jumpRandTimer -= dt;
    if (this.jumpRandTimer <= 0) {
      const hopChance = prof.jumpRand * (state === 'ENGAGE' ? 0.6 : 1.0);
      if (this.onGround && Math.random() < hopChance) {
        this.velocity.y = JUMP_VEL * (this.game.frenzy?.id === 'lowGrav' ? 1.35 : 1);
        this.onGround = false;
      }
      this.jumpRandTimer = 0.8 + Math.random() * 1.2;
    }

    // ----- movement direction -----
    const moveDir = new THREE.Vector3();
    const idealRange = w.fireRate < 0.15 ? 12 : (w.projectileSpeed > 150 ? 25 : 14);

    if (state === 'ENGAGE') {
      if (targetDist < idealRange + 4 && targetDist > idealRange - 4) {
        // Stand fairly still — only mild strafe — so we can actually aim
        if (Math.random() < 0.6) {
          // hold position
        } else {
          const toT = new THREE.Vector3().subVectors(this.target.position, this.position);
          toT.y = 0; toT.normalize();
          const perp = new THREE.Vector3(-toT.z, 0, toT.x);
          moveDir.copy(perp).multiplyScalar(this.strafeDir);
        }
        if (Math.random() < 0.006) this.strafeDir = -this.strafeDir;
      } else if (targetDist < idealRange - 4) {
        // back away
        const toT = new THREE.Vector3().subVectors(this.target.position, this.position);
        toT.y = 0; toT.normalize();
        moveDir.copy(toT).multiplyScalar(-1);
      } else {
        // close in via path
        this.followPath(moveDir);
      }
    } else {
      // HUNT, FLEE, PEEK — follow path
      this.followPath(moveDir);
    }

    // HOLD HIGH GROUND — after warping to a tower, lock movement so the bot
    // fires from up there instead of walking off the edge. Tiny strafe is
    // allowed so they're still juke-able to incoming fire.
    if (this.heightHoldTimer > 0 && this.position.y > 4) {
      moveDir.set(0, 0, 0);
      if (this.target) {
        const toT = new THREE.Vector3().subVectors(this.target.position, this.position);
        toT.y = 0;
        if (toT.lengthSq() > 0.01) {
          toT.normalize();
          const perp = new THREE.Vector3(-toT.z, 0, toT.x);
          moveDir.copy(perp).multiplyScalar(this.strafeDir * 0.25);
        }
      }
      if (Math.random() < 0.01) this.strafeDir = -this.strafeDir;
    }

    // ----- sprint -----
    const moving = moveDir.lengthSq() > 0.01;
    this.sprinting = moving && (state === 'HUNT' || state === 'FLEE' || state === 'PEEK');

    // smoothed velocity (XZ only — Y handled by gravity)
    let baseSpeed = SPEED * prof.speedMult;
    if (this.sprinting) baseSpeed *= SPRINT_MULT;
    if (this.game.frenzy?.id === 'speedDemon') baseSpeed *= 1.35;
    if (state === 'ENGAGE' && this.fireCooldown < 0.25) baseSpeed *= 0.55; // slow while shooting
    // Comeback / push-through rally — losing team gets a small speed boost so
    // they actually break out of their own keep instead of trickling forward.
    if (this.game.pushThroughTeam === this.team) baseSpeed *= 1.18;
    // Trigger a dash when closing in long-range, or when fleeing low HP, with low chance
    if (this.dashCooldown <= 0 && this.dashTimer <= 0) {
      if (state === 'HUNT' && this.target && targetDist > 18 && Math.random() < 0.04) {
        this.triggerDash(moveDir);
      } else if (state === 'FLEE' && Math.random() < 0.06) {
        this.triggerDash(moveDir);
      }
    }
    // Trigger a slide-dash on long approaches OR when peeking out for re-engage
    if (this.slideCooldown <= 0 && this.slideTimer <= 0) {
      if (state === 'HUNT' && this.target && targetDist > 22 && Math.random() < 0.05) {
        this.triggerSlide(moveDir);
      } else if (state === 'PEEK' && this.target && targetDist < 14 && Math.random() < 0.04) {
        // sideways slide breaks LOS without committing to retreat
        const toT = new THREE.Vector3().subVectors(this.target.position, this.position);
        toT.y = 0;
        if (toT.lengthSq() > 0.01) {
          toT.normalize();
          const perp = new THREE.Vector3(-toT.z, 0, toT.x).multiplyScalar(this.strafeDir);
          this.triggerSlide(perp);
        }
      }
    }
    const desired = moveDir.multiplyScalar(baseSpeed);
    this.velocity.x += (desired.x - this.velocity.x) * Math.min(1, dt * 8);
    this.velocity.z += (desired.z - this.velocity.z) * Math.min(1, dt * 8);
    // Override during active dash — slam in dash direction at high speed
    if (this.dashTimer > 0) {
      this.velocity.x = this.dashDir.x * baseSpeed * 3.2;
      this.velocity.z = this.dashDir.z * baseSpeed * 3.2;
    }
    // Override during active slide — slick high-speed glide in slide direction
    if (this.slideTimer > 0) {
      this.velocity.x = this.slideDir.x * baseSpeed * 2.4;
      this.velocity.z = this.slideDir.z * baseSpeed * 2.4;
    }

    // accuracy bonus for staying still in ENGAGE (used by fire())
    if (state === 'ENGAGE' && !moving) this.engageStillTimer = Math.min(1.5, this.engageStillTimer + dt);
    else this.engageStillTimer = Math.max(0, this.engageStillTimer - dt * 2);

    // gravity — honors the LOW GRAVITY frenzy so bots also float / leap higher
    const gravMult = this.game.frenzy?.id === 'lowGrav' ? 0.45 : 1;
    this.velocity.y -= GRAVITY * gravMult * dt;

    // proposed XZ — sub-stepped per axis so the bot can't tunnel through thin
    // walls and so collision resolution on one obstacle never ejects the bot
    // INTO another (e.g. wall-and-pillar wedges at the keep gate).
    const newPos = this.position.clone();
    const dispX = this.velocity.x * dt;
    const dispZ = this.velocity.z * dt;
    const subX = Math.max(1, Math.ceil(Math.abs(dispX) / 0.3));
    const subZ = Math.max(1, Math.ceil(Math.abs(dispZ) / 0.3));
    const incX = dispX / subX;
    const incZ = dispZ / subZ;
    for (let s = 0; s < subX; s++) {
      newPos.x += incX;
      this.resolveBotCollisionAxis(newPos, 'x');
    }
    for (let s = 0; s < subZ; s++) {
      newPos.z += incZ;
      this.resolveBotCollisionAxis(newPos, 'z');
    }

    // arena bounds (after collision so we don't get re-pushed into a wall)
    const B = this.game.arena.bounds;
    newPos.x = Math.max(-B + this.radius, Math.min(B - this.radius, newPos.x));
    newPos.z = Math.max(-B + this.radius, Math.min(B - this.radius, newPos.z));

    // anti spawn-camp: don't allow bots to enter the OTHER team's spawn zone.
    const enemyTeam = this.team === 'mash' ? 'russet' : 'mash';
    const zone = this.game.arena.teamSpawnZones[enemyTeam];
    if (zone) {
      const r = this.radius;
      const inX = newPos.x > zone.minX - r && newPos.x < zone.maxX + r;
      const inZ = newPos.z > zone.minZ - r && newPos.z < zone.maxZ + r;
      if (inX && inZ) {
        const dMinX = (newPos.x) - (zone.minX - r);
        const dMaxX = (zone.maxX + r) - newPos.x;
        const dMinZ = (newPos.z) - (zone.minZ - r);
        const dMaxZ = (zone.maxZ + r) - newPos.z;
        const m = Math.min(dMinX, dMaxX, dMinZ, dMaxZ);
        if (m === dMinX) newPos.x = zone.minX - r;
        else if (m === dMaxX) newPos.x = zone.maxX + r;
        else if (m === dMinZ) newPos.z = zone.minZ - r;
        else newPos.z = zone.maxZ + r;
        if (this.repathTimer > 0.2) this.repathTimer = 0.15;
      }
    }

    // Y physics — gravity-driven. Ground is the higher of (navgrid surface)
    // OR (top of any obstacle the bot is currently standing over). Without the
    // obstacle check, bots warped onto a tower would fall straight through
    // because the nav grid drops anything taller than MAX_GROUND.
    newPos.y += this.velocity.y * dt;
    let groundY = this.game.navGrid.getHeightAt(newPos.x, newPos.z);
    const footBefore = this.position.y - 0.85;
    for (const obs of this.game.arena.obstacles) {
      const cx = obs.x + obs.w / 2;
      const cz = obs.z + obs.d / 2;
      if (Math.abs(newPos.x - cx) >= obs.w / 2 + this.radius) continue;
      if (Math.abs(newPos.z - cz) >= obs.d / 2 + this.radius) continue;
      const obsTop = obs.y + obs.h;
      // Only count obstacles the bot is descending onto — the foot must be
      // at or above the obstacle top before this frame.
      if (obsTop <= footBefore + 0.05 && obsTop > groundY) groundY = obsTop;
    }
    const minY = groundY + 0.85;
    if (newPos.y <= minY) {
      newPos.y = minY;
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    this.position.copy(newPos);

    this.mesh.position.copy(this.position);
    if (this.onGround) {
      this.mesh.position.y += Math.sin(performance.now() * 0.005 + this.id) * 0.04;
    }
    if (this.bountyCrown && this.bountyCrown.visible) {
      this.bountyCrown.rotation.y += dt * 2.6;
    }
    if (this.target) {
      this.mesh.rotation.y = Math.atan2(
        this.target.position.x - this.position.x,
        this.target.position.z - this.position.z
      );
    }

    // health bar billboard
    const barPos = this.position.clone();
    barPos.y += 1.7;
    this.healthBarBg.position.copy(barPos);
    this.healthBarFill.position.copy(barPos);
    this.healthBarBg.lookAt(this.game.camera.position);
    this.healthBarFill.lookAt(this.game.camera.position);
    const pct = this.health / this.maxHealth;
    this.healthBarFill.scale.x = pct;
    const teamColor = TEAM_COLORS[this.team];
    this.healthBarFill.material.color.setHex(pct > 0.5 ? teamColor : pct > 0.25 ? 0xff8a3c : 0xff3a3a);

    // Hot-streak aura: visible when CURRENT streak >= 5. Resets on death so
    // a respawned bot doesn't inherit aura/glow from a previous life.
    if (this.aura) {
      const streak = this.streak || 0;
      if (streak >= 5) {
        this.aura.visible = true;
        if (this.auraInner) this.auraInner.visible = true;
        const intensity = Math.min(1, (streak - 4) / 8); // 5→0.125 .. 12+→1
        const t = performance.now() * 0.008;
        const pulse = 0.55 + 0.25 * Math.sin(t);
        const pulse2 = 0.55 + 0.25 * Math.sin(t + 1.3);
        this.aura.material.opacity = 0.55 + 0.35 * intensity * pulse;
        if (this.auraInner) this.auraInner.material.opacity = 0.45 + 0.4 * intensity * pulse2;
        const grow = 1 + intensity * 0.3;
        this.aura.scale.set(grow, grow, 1);
        if (this.auraInner) this.auraInner.scale.set(grow, grow, 1);
        // Outer ring shifts hotter (team→gold) with streak length
        const baseHex = TEAM_COLORS[this.team];
        const goldHex = 0xffd700;
        const baseC = new THREE.Color(baseHex);
        const goldC = new THREE.Color(goldHex);
        this.aura.material.color.copy(baseC).lerp(goldC, intensity);
      } else if (this.aura.visible) {
        this.aura.visible = false;
        if (this.auraInner) this.auraInner.visible = false;
      }
      const fy = this.position.y - 0.82;
      this.aura.position.set(this.position.x, fy + 0.04, this.position.z);
      this.aura.rotation.z += dt * 1.2;
      if (this.auraInner) {
        this.auraInner.position.set(this.position.x, fy + 0.05, this.position.z);
        this.auraInner.rotation.z -= dt * 1.5;
      }
    }

    // recoil decay
    this.recoilCharge = Math.max(0, this.recoilCharge - dt * 1.5);

    // weapon timing
    this.fireCooldown -= dt;
    if (this.firstSightTime > 0) this.firstSightTime -= dt;

    // Try to activate a special move when in the right tactical situation
    if (state === 'ENGAGE' && hasLos && this.target && this.specialCooldown <= 0 &&
        !this.specialBurstRemaining && !this.reloading) {
      this.tryActivateSpecial(targetDist);
    }

    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.mag = w.magSize;
        this.reloading = false;
      }
    } else if (this.specialBurstRemaining > 0 && this.specialBurstTimer <= 0 &&
               hasLos && this.target && this.mag > 0) {
      // Auto-fire queued burst (Sizzle Burst, Quick Fire)
      this.fire();
      this.mag--;
      this.specialBurstRemaining--;
      this.specialBurstTimer = this.specialBurstGap;
      if (this.specialBurstRemaining <= 0 || this.mag === 0) {
        this.specialBurstRemaining = 0;
        if (this.mag === 0) this.startReload();
      }
    } else if (state === 'ENGAGE' && this.target && hasLos && this.fireCooldown <= 0 && this.firstSightTime <= 0) {
      // Ammo conservation: precise weapons (sniper/shotgun/launcher) wait for a high-confidence shot.
      // Auto/SMG-class weapons can spray since they're cheap-per-shot.
      const precise = w.fireRate >= 0.5;
      const settled = this.engageStillTimer > 0.16;
      const close = targetDist < 11;
      const lowRecoil = this.recoilCharge < 1.6;
      const confident = !precise || settled || close || lowRecoil;
      if (this.mag > 0 && confident) {
        this.fire();
        this.mag--;
        const hotMult = this.hotBarrelTimer > 0 ? 0.5 : 1;
        // Push-through: cornered team gets faster cycle to break the stalemate
        const rallyMult = this.game.pushThroughTeam === this.team ? 0.82 : 1;
        const frenzyFireMult = this.game.frenzy?.id === 'fastFire' ? (1 / 1.5) : 1;
        this.fireCooldown = w.fireRate * prof.fireRateMult * hotMult * rallyMult * frenzyFireMult + Math.random() * 0.05;
        if (this.mag === 0) this.startReload();
      } else if (this.mag === 0) {
        this.startReload();
      }
    } else if (this.mag === 0 && !this.reloading) {
      // Reload while travelling — don't wait until back in fight
      this.startReload();
    }
  }

  startReload() {
    if (this.reloading) return;
    // HOT BARREL / instaReload frenzy: skip the timer entirely so bots match
    // the player's instant-reload pace during the event.
    if (this.game.frenzy && this.game.frenzy.id === 'instaReload') {
      this.mag = this.weapon.magSize;
      return;
    }
    this.reloading = true;
    this.reloadTimer = this.weapon.reloadTime;
  }

  // Decide whether to pop the weapon's special right now and apply its effect.
  // Each kind has different ideal preconditions (range, mag size, settled aim).
  tryActivateSpecial(targetDist) {
    const sp = this.weapon.special;
    if (!sp) return;
    if (sp.kind === 'burst') {
      if (targetDist < 22 && this.mag >= Math.min(sp.shots, 2)) {
        this.specialBurstRemaining = Math.min(sp.shots, this.mag);
        this.specialBurstGap = sp.gap;
        this.specialBurstTimer = 0;
        this.specialCooldown = sp.cooldown;
      }
    } else if (sp.kind === 'slug') {
      // Slugs shine at medium range, where pellets fall off
      if (targetDist > 12 && targetDist < 35 && this.mag > 0) {
        this.specialMod = { type: 'slug', damage: sp.damage, projectileSize: sp.projectileSize };
        this.specialCooldown = sp.cooldown;
      }
    } else if (sp.kind === 'hotBarrel') {
      // SMG burst window — sustained engagement
      if (targetDist < 26 && this.mag > 6) {
        this.hotBarrelTimer = sp.duration;
        this.specialCooldown = sp.cooldown;
      }
    } else if (sp.kind === 'steady') {
      // Sniper line-up shot — at range, with settled aim
      if (this.engageStillTimer > 0.1 && this.mag > 0 && targetDist > 18) {
        this.specialMod = { type: 'steady' };
        this.specialCooldown = sp.cooldown;
      }
    } else if (sp.kind === 'fan') {
      // Triple Tater — area denial when target is in a corridor
      if (targetDist > 8 && targetDist < 30 && this.mag > 0) {
        this.specialMod = { type: 'fan', count: sp.count, spread: sp.spread };
        this.specialCooldown = sp.cooldown;
      }
    }
  }

  fire() {
    const w = this.weapon;
    const prof = this.profile;
    const target = this.target;
    if (!target) return;
    const muzzle = this.position.clone();
    muzzle.y += 0.3;
    // Distance-attenuated SFX so other potatoes' shots are audible at range
    if (this.game.sfx && this.game.player) {
      const dist = muzzle.distanceTo(this.game.player.position);
      if (this.weaponKey === 'tossor') {
        this.game.sfx.grenadeBoomAt(dist);
      } else if (this.weaponKey === 'knife') {
        // bots don't really use knife but if they do it's a swing not a shot
      } else {
        this.game.sfx.gunshotAt(this.weaponKey, dist);
      }
    }

    // lead the target — skill dependent
    const dist = target.position.distanceTo(muzzle);
    const projT = dist / w.projectileSpeed;
    const leadPos = target.position.clone();
    if (target.velocity) {
      leadPos.x += target.velocity.x * projT * prof.leadMult;
      leadPos.z += target.velocity.z * projT * prof.leadMult;
    }
    leadPos.y += target === this.game.player ? -0.4 : 0.4;

    const dir = new THREE.Vector3().subVectors(leadPos, muzzle).normalize();

    // Apply special-move modifier for this single shot
    const mod = this.specialMod;
    let pellets = w.pellets || 1;
    let damage = w.damage;
    let projectileSize = w.projectileSize;
    let spreadOverride = null;
    let recoilFactor = 1;
    if (mod) {
      if (mod.type === 'slug') {
        pellets = 1;
        damage = mod.damage;
        if (mod.projectileSize) projectileSize = mod.projectileSize;
        spreadOverride = 0.005;
      } else if (mod.type === 'fan') {
        pellets = mod.count;
        spreadOverride = mod.spread;
      } else if (mod.type === 'steady') {
        spreadOverride = 0.005;
        recoilFactor = 0.3;
      }
      this.specialMod = null;
    }

    // skill aim error + weapon spread + recoil-build spread, with a still-aim bonus
    const recoilSpread = this.recoilCharge * 0.04;
    const stillBonus = Math.min(0.6, this.engageStillTimer * 0.5); // 0..0.6 multiplier reduction
    // High-ground bonus: bots perched above 4m get a 35% accuracy boost (and
    // bots above 7m, like outpost tops, get 50%). Encourages outpost camping.
    let highGroundBonus = 0;
    if (this.position.y > 7) highGroundBonus = 0.50;
    else if (this.position.y > 4) highGroundBonus = 0.35;
    // Anti-player aim handicap — bots get notably less accurate when shooting
    // at the human so single shots don't delete the player. Bot-vs-bot stays
    // tight so AI kill counts stay healthy and the leaderboard isn't lopsided.
    const targetIsPlayer = target === this.game.player;
    const vsPlayerErrorMult = targetIsPlayer ? 2.6 : 1.0;
    const baseAccuracy = (prof.aimError * vsPlayerErrorMult + (w.spread || 0) * 0.5 + recoilSpread) * (1 - stillBonus) * (1 - highGroundBonus);
    const accuracy = spreadOverride != null ? Math.min(spreadOverride, baseAccuracy) : baseAccuracy;
    for (let i = 0; i < pellets; i++) {
      const d = dir.clone();
      d.x += (Math.random() - 0.5) * accuracy;
      d.y += (Math.random() - 0.5) * accuracy;
      d.z += (Math.random() - 0.5) * accuracy;
      d.normalize();
      this.game.spawnProjectile({
        ownerEntity: this,
        ownerTeam: this.team,
        position: muzzle,
        velocity: d.multiplyScalar(w.projectileSpeed),
        damage,
        size: projectileSize,
        gravity: w.gravity || 0,
        explosionRadius: w.explosionRadius || 0,
        impactExplode: !!w.impactExplode,
        fuse: w.fuse,
        color: w.projectileColor,
        falloff: w.falloff,
      });
    }

    this.recoilCharge = Math.min(this.recoilCharge + 0.6 * prof.recoilGain * recoilFactor, 4.0);
  }

  // ===== DAD (manual player 2) =====
  // Runs INSTEAD of the AI update when this.manual === true. Reads
  // game.dadKeys (set by main.js) for arrow-key movement/turning and
  // slash/period/comma for shoot/jump/reload. Aim assist locks onto the
  // nearest visible enemy in a wide front cone so dad doesn't need a mouse.
  manualUpdate(dt) {
    const keys = this.game.dadKeys || {};
    const w = this.weapon;

    if (this.spawnInvuln > 0) this.spawnInvuln -= dt;
    if (this.fireCooldown > 0) this.fireCooldown -= dt;
    if (this.specialCooldown > 0) this.specialCooldown -= dt;
    if (this.hotBarrelTimer > 0) this.hotBarrelTimer -= dt;
    this.timeSinceDamage += dt;
    if (this.timeSinceDamage > 4.0 && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + 1 * dt);
    }

    // Reload (manual via comma OR auto when mag hits 0)
    if (this.reloading) {
      this.reloadTimer -= dt;
      if (this.reloadTimer <= 0) {
        this.mag = w.magSize;
        this.reloading = false;
      }
    } else if (!w.melee && (this.mag <= 0 || (keys.Comma && this.mag < w.magSize))) {
      if (this.game.frenzy && this.game.frenzy.id === 'instaReload') {
        this.mag = w.magSize;            // instant — no timer
      } else {
        this.reloading = true;
        this.reloadTimer = w.reloadTime;
      }
    }

    // Turn
    const TURN_RATE = 2.4;
    if (keys.ArrowLeft)  this.yaw += dt * TURN_RATE;
    if (keys.ArrowRight) this.yaw -= dt * TURN_RATE;

    // Move
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const move = new THREE.Vector3();
    if (keys.ArrowUp)   move.add(forward);
    if (keys.ArrowDown) move.sub(forward);
    if (move.lengthSq() > 0) move.normalize();
    const speed = 6.0;
    this.velocity.x = move.x * speed;
    this.velocity.z = move.z * speed;

    // Jump
    if (keys.Period && this.onGround) {
      this.velocity.y = JUMP_VEL;
      this.onGround = false;
    }

    // Gravity
    this.velocity.y -= GRAVITY * dt;

    // Sub-stepped XZ collision (reuses bot collision helper)
    const newPos = this.position.clone();
    const dispX = this.velocity.x * dt;
    const dispZ = this.velocity.z * dt;
    const subX = Math.max(1, Math.ceil(Math.abs(dispX) / 0.3));
    const subZ = Math.max(1, Math.ceil(Math.abs(dispZ) / 0.3));
    const incX = dispX / subX;
    const incZ = dispZ / subZ;
    for (let s = 0; s < subX; s++) { newPos.x += incX; this.resolveBotCollisionAxis(newPos, 'x'); }
    for (let s = 0; s < subZ; s++) { newPos.z += incZ; this.resolveBotCollisionAxis(newPos, 'z'); }

    const B = this.game.arena.bounds;
    newPos.x = Math.max(-B + this.radius, Math.min(B - this.radius, newPos.x));
    newPos.z = Math.max(-B + this.radius, Math.min(B - this.radius, newPos.z));

    // Y physics — ground or obstacle top
    newPos.y += this.velocity.y * dt;
    let groundY = this.game.navGrid.getHeightAt(newPos.x, newPos.z);
    const footBefore = this.position.y - 0.85;
    for (const obs of this.game.arena.obstacles) {
      const cx = obs.x + obs.w / 2;
      const cz = obs.z + obs.d / 2;
      if (Math.abs(newPos.x - cx) >= obs.w / 2 + this.radius) continue;
      if (Math.abs(newPos.z - cz) >= obs.d / 2 + this.radius) continue;
      const obsTop = obs.y + obs.h;
      if (obsTop <= footBefore + 0.05 && obsTop > groundY) groundY = obsTop;
    }
    const minY = groundY + 0.85;
    if (newPos.y <= minY) {
      newPos.y = minY;
      this.velocity.y = 0;
      this.onGround = true;
    } else {
      this.onGround = false;
    }
    this.position.copy(newPos);

    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.yaw;
    if (this.bountyCrown && this.bountyCrown.visible) this.bountyCrown.rotation.y += dt * 2.6;

    // Aim assist: pick best enemy in a wide front cone, snap aim at them
    let aimTarget = null;
    let bestScore = Infinity;
    const aimDir = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const cands = [];
    for (const b of this.game.bots) {
      if (!b.dead && b.team !== this.team && b !== this) cands.push(b);
    }
    if (!this.game.player.dead && this.game.player.team !== this.team) cands.push(this.game.player);
    for (const c of cands) {
      const to = new THREE.Vector3().subVectors(c.position, this.position);
      const dist = to.length();
      if (dist > 55 || dist < 1.2) continue;
      to.normalize();
      const dot = to.dot(aimDir);
      if (dot < 0.5) continue;
      const score = dist * (1 - dot * 0.75);
      if (score < bestScore) { bestScore = score; aimTarget = c; }
    }
    this.manualAimTarget = aimTarget;

    // Fire (held)
    if (keys.Slash && this.fireCooldown <= 0 && !this.reloading && !w.melee && this.mag > 0) {
      this.manualFire(aimTarget);
      this.mag -= 1;
      const hotMult = this.hotBarrelTimer > 0 ? 0.5 : 1;
      this.fireCooldown = w.fireRate * hotMult;
    }

    // Update camera2 to track dad first-person
    if (this.game.camera2) {
      const cam = this.game.camera2;
      cam.position.copy(this.position);
      cam.position.y += 0.75;
      // Push the camera slightly forward to clear the potato body
      cam.position.x += -Math.sin(this.yaw) * 0.05;
      cam.position.z += -Math.cos(this.yaw) * 0.05;
      cam.rotation.order = 'YXZ';
      cam.rotation.y = this.yaw;
      cam.rotation.x = 0;
    }

    // Health bar billboards face the MAIN camera (the P1 view that needs to see them)
    const barPos = this.position.clone();
    barPos.y += 1.7;
    this.healthBarBg.position.copy(barPos);
    this.healthBarFill.position.copy(barPos);
    this.healthBarBg.lookAt(this.game.camera.position);
    this.healthBarFill.lookAt(this.game.camera.position);
    const pct = this.health / this.maxHealth;
    this.healthBarFill.scale.x = pct;
    const teamColor = TEAM_COLORS[this.team];
    this.healthBarFill.material.color.setHex(pct > 0.5 ? teamColor : pct > 0.25 ? 0xff8a3c : 0xff3a3a);

    // DAD aura — always pulsing, bright pink/cyan
    if (this.aura) {
      this.aura.visible = true;
      this.aura.position.set(this.position.x, this.position.y - 0.83, this.position.z);
      const t = performance.now() * 0.006;
      this.aura.material.opacity = 0.55 + 0.35 * Math.sin(t);
      this.aura.rotation.z += dt * 1.5;
    }
    if (this.auraInner) {
      this.auraInner.visible = true;
      this.auraInner.position.set(this.position.x, this.position.y - 0.82, this.position.z);
      const t = performance.now() * 0.006;
      this.auraInner.material.opacity = 0.5 + 0.4 * Math.sin(t + 1.5);
      this.auraInner.rotation.z -= dt * 1.8;
    }
  }

  // Manual fire (used by DAD). Mirrors bot.fire() but uses aim-assist target
  // (or current yaw if none) and skips lead/skill error.
  manualFire(aimTarget) {
    const w = this.weapon;
    const muzzle = this.position.clone();
    muzzle.y += 0.5;
    if (this.game.sfx && this.game.player) {
      const dist = muzzle.distanceTo(this.game.player.position);
      if (this.weaponKey === 'tossor') this.game.sfx.grenadeBoomAt(dist);
      else this.game.sfx.gunshotAt(this.weaponKey, dist);
    }
    let dir;
    if (aimTarget) {
      const tp = aimTarget.position.clone();
      tp.y += aimTarget === this.game.player ? -0.3 : 0.4;
      dir = new THREE.Vector3().subVectors(tp, muzzle).normalize();
    } else {
      dir = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    }
    const muzzlePos = muzzle.clone().addScaledVector(dir, 0.6);
    const pellets = w.pellets || 1;
    const spread = (w.spread || 0) * 0.6;
    for (let i = 0; i < pellets; i++) {
      const d = dir.clone();
      if (spread > 0) {
        d.x += (Math.random() - 0.5) * spread * 2;
        d.y += (Math.random() - 0.5) * spread * 2;
        d.z += (Math.random() - 0.5) * spread * 2;
        d.normalize();
      }
      this.game.spawnProjectile({
        ownerEntity: this,
        ownerTeam: this.team,
        position: muzzlePos,
        velocity: d.multiplyScalar(w.projectileSpeed),
        damage: w.damage,
        size: w.projectileSize,
        gravity: w.gravity || 0,
        explosionRadius: w.explosionRadius || 0,
        impactExplode: !!w.impactExplode,
        fuse: w.fuse,
        color: w.projectileColor,
        falloff: w.falloff,
      });
    }
  }

  damage(amount, attacker) {
    if (this.dead) return;
    if (this.spawnInvuln > 0) return;
    const beforeHp = this.health;
    this.health -= amount;
    this.timeSinceDamage = 0;
    // Spook on damage — high HP bots barely flinch and push the fight
    this.spookedTimer = this.health > this.maxHealth * 0.55
      ? 0.2 + Math.random() * 0.3
      : 0.5 + Math.random() * 0.5;
    if (attacker && attacker.position) this.lastAttacker = attacker;
    this.coverSearchCooldown = 0;
    this.repathTimer = Math.min(this.repathTimer, 0.1);
    // Chat: low HP first time crossing 30%
    if (beforeHp >= this.maxHealth * 0.30 && this.health < this.maxHealth * 0.30 && this.health > 0) {
      this.emitChat('lowHp');
    }
    if (this.health <= 0) this.die(attacker);
  }

  die(attacker) {
    this.dead = true;
    this.streak = 0;
    this.emitChat('death');
    // Notify buddy so they can react
    if (this.buddy && !this.buddy.dead) {
      this.buddy.emitChat('buddyDown');
      // Buddy gets a brief vengeance buff: faster fire, sharper aim
      this.buddy.spookedTimer = 0;
      this.buddy.recoilCharge *= 0.4;
      // Re-target to whoever killed us if they're a valid candidate, and tag
      // them as the avenge target so the next kill on them speaks 'avenged'.
      if (attacker && typeof attacker === 'object' && !attacker.dead && attacker.team !== this.buddy.team) {
        this.buddy.committedTarget = attacker;
        this.buddy.targetLostTimer = 0;
        this.buddy.avengeTarget = attacker;
      }
      this.buddy.buddy = null;
    }
    this.game.scene.remove(this.mesh);
    this.game.scene.remove(this.healthBarBg);
    this.game.scene.remove(this.healthBarFill);
    if (this.aura) {
      this.game.scene.remove(this.aura);
      this.aura.geometry.dispose();
      this.aura.material.dispose();
      this.aura = null;
    }
    if (this.auraInner) {
      this.game.scene.remove(this.auraInner);
      this.auraInner.geometry.dispose();
      this.auraInner.material.dispose();
      this.auraInner = null;
    }
    this.mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.healthBarBg.geometry.dispose();
    this.healthBarBg.material.dispose();
    this.healthBarFill.geometry.dispose();
    this.healthBarFill.material.dispose();
    this.game.spawnExplosion(this.position.clone(), 1.5, 0xc47a3d);
    // Loot drop: 28% basic, 5% rare. Only drops on player kills so the player
    // sees the dopamine — bot-on-bot fights would be lost in the noise.
    const playerKilled = attacker === 'player' || attacker === this.game.player;
    if (playerKilled) {
      const r = Math.random();
      if (r < 0.05) this.dropLoot('rare');
      else if (r < 0.33) this.dropLoot('basic');
    }
    this.game.onBotKilled(this, attacker);
  }

  dropLoot(tier) {
    const pos = this.position.clone();
    pos.y = Math.max(pos.y, 0.4);
    const pk = new Pickup(this.game, 'loot', pos, { tier, ephemeral: true });
    this.game.pickups.push(pk);
  }
}
