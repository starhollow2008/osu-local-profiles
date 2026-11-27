/**
 * Mod names, types and setting labels. GENERATED -- do not edit.
 *
 * Rebuild with `node scripts/build-mod-table.mjs`. Source: https://raw.githubusercontent.com/ppy/osu-web/master/database/mods.json
 *
 * `type` is what gives a mod its colour (ppy/osu's OsuColour.ForModType), so this file
 * is the reason a badge is the right one rather than a guess. `modes` is which rulesets
 * offer the mod, numbered as this app numbers them, and `playable` is false for the three
 * a player cannot choose (Autoplay, Cinema, ScoreV2).
 *
 * Every list of mods to choose from follows osu-web's order, which is osu!'s (`compareMods` in
 * badges.js): `MOD_ORDER` is each ruleset's as osu-web lists it, and this table is in one order
 * for lists that show every ruleset at once.
 */
export const MOD_DEFINITIONS = {
  "EZ": {"name":"Easy","type":"DifficultyReduction","modes":[0,1,2,3],"playable":true,"settings":{"retries":"Extra Lives"}},
  "NF": {"name":"No Fail","type":"DifficultyReduction","modes":[0,1,2,3],"playable":true,"settings":{}},
  "HT": {"name":"Half Time","type":"DifficultyReduction","modes":[0,1,2,3],"playable":true,"settings":{"speed_change":"Speed decrease","adjust_pitch":"Adjust pitch"}},
  "DC": {"name":"Daycore","type":"DifficultyReduction","modes":[0,1,2,3],"playable":true,"settings":{"speed_change":"Speed decrease"}},
  "NR": {"name":"No Release","type":"DifficultyReduction","modes":[3],"playable":true,"settings":{}},
  "SR": {"name":"Simplified Rhythm","type":"DifficultyReduction","modes":[1],"playable":true,"settings":{"one_third_conversion":"1/3 to 1/2 conversion","one_sixth_conversion":"1/6 to 1/4 conversion","one_eighth_conversion":"1/8 to 1/4 conversion"}},
  "HR": {"name":"Hard Rock","type":"DifficultyIncrease","modes":[0,1,2,3],"playable":true,"settings":{}},
  "SD": {"name":"Sudden Death","type":"DifficultyIncrease","modes":[0,1,2,3],"playable":true,"settings":{"fail_on_slider_tail":"Also fail when missing a slider tail","restart":"Restart on fail"}},
  "PF": {"name":"Perfect","type":"DifficultyIncrease","modes":[0,1,2,3],"playable":true,"settings":{"restart":"Restart on fail","require_perfect_hits":"Require perfect hits"}},
  "DT": {"name":"Double Time","type":"DifficultyIncrease","modes":[0,1,2,3],"playable":true,"settings":{"speed_change":"Speed increase","adjust_pitch":"Adjust pitch"}},
  "NC": {"name":"Nightcore","type":"DifficultyIncrease","modes":[0,1,2,3],"playable":true,"settings":{"speed_change":"Speed increase"}},
  "FI": {"name":"Fade In","type":"DifficultyIncrease","modes":[3],"playable":true,"settings":{}},
  "HD": {"name":"Hidden","type":"DifficultyIncrease","modes":[0,1,2,3],"playable":true,"settings":{"only_fade_approach_circles":"Only fade approach circles"}},
  "CO": {"name":"Cover","type":"DifficultyIncrease","modes":[3],"playable":true,"settings":{"coverage":"Coverage","direction":"Direction"}},
  "TC": {"name":"Traceable","type":"DifficultyIncrease","modes":[0],"playable":true,"settings":{}},
  "FL": {"name":"Flashlight","type":"DifficultyIncrease","modes":[0,1,2,3],"playable":true,"settings":{"follow_delay":"Follow delay","size_multiplier":"Flashlight size","combo_based_size":"Change size based on combo"}},
  "BL": {"name":"Blinds","type":"DifficultyIncrease","modes":[0],"playable":true,"settings":{}},
  "ST": {"name":"Strict Tracking","type":"DifficultyIncrease","modes":[0],"playable":true,"settings":{}},
  "AC": {"name":"Accuracy Challenge","type":"DifficultyIncrease","modes":[0,1,2,3],"playable":true,"settings":{"minimum_accuracy":"Minimum accuracy","accuracy_judge_mode":"Accuracy mode","restart":"Restart on fail"}},
  "TP": {"name":"Target Practice","type":"Conversion","modes":[0],"playable":true,"settings":{"seed":"Seed","metronome":"Metronome ticks"}},
  "DA": {"name":"Difficulty Adjust","type":"Conversion","modes":[0,1,2,3],"playable":true,"settings":{"circle_size":"Circle Size","approach_rate":"Approach Rate","drain_rate":"HP Drain","overall_difficulty":"Accuracy","extended_limits":"Extended Limits","scroll_speed":"Scroll Speed","hard_rock_offsets":"Spicy Patterns"}},
  "CL": {"name":"Classic","type":"Conversion","modes":[0,1,2,3],"playable":true,"settings":{"no_slider_head_accuracy":"No slider head accuracy requirement","classic_note_lock":"Apply classic note lock","always_play_tail_sample":"Always play a slider's tail sample","fade_hit_circle_early":"Fade out hit circles earlier","classic_health":"Classic health"}},
  "IN": {"name":"Invert","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "SW": {"name":"Swap","type":"Conversion","modes":[1],"playable":true,"settings":{}},
  "RD": {"name":"Random","type":"Conversion","modes":[0,1,3],"playable":true,"settings":{"angle_sharpness":"Angle sharpness","seed":"Seed"}},
  "DS": {"name":"Dual Stages","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "MR": {"name":"Mirror","type":"Conversion","modes":[0,2,3],"playable":true,"settings":{"reflection":"Flipped axes"}},
  "AL": {"name":"Alternate","type":"Conversion","modes":[0],"playable":true,"settings":{}},
  "SG": {"name":"Single Tap","type":"Conversion","modes":[0,1],"playable":true,"settings":{}},
  "CS": {"name":"Constant Speed","type":"Conversion","modes":[1,3],"playable":true,"settings":{}},
  "HO": {"name":"Hold Off","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "1K": {"name":"One Key","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "2K": {"name":"Two Keys","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "3K": {"name":"Three Keys","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "4K": {"name":"Four Keys","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "5K": {"name":"Five Keys","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "6K": {"name":"Six Keys","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "7K": {"name":"Seven Keys","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "8K": {"name":"Eight Keys","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "9K": {"name":"Nine Keys","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "10K": {"name":"Ten Keys","type":"Conversion","modes":[3],"playable":true,"settings":{}},
  "AT": {"name":"Autoplay","type":"Automation","modes":[0,1,2,3],"playable":false,"settings":{}},
  "CN": {"name":"Cinema","type":"Automation","modes":[0,1,2,3],"playable":false,"settings":{}},
  "RX": {"name":"Relax","type":"Automation","modes":[0,1,2],"playable":true,"settings":{}},
  "AP": {"name":"Autopilot","type":"Automation","modes":[0],"playable":true,"settings":{}},
  "SO": {"name":"Spun Out","type":"Automation","modes":[0],"playable":true,"settings":{}},
  "TR": {"name":"Transform","type":"Fun","modes":[0],"playable":true,"settings":{}},
  "WG": {"name":"Wiggle","type":"Fun","modes":[0],"playable":true,"settings":{"strength":"Strength"}},
  "SI": {"name":"Spin In","type":"Fun","modes":[0],"playable":true,"settings":{}},
  "GR": {"name":"Grow","type":"Fun","modes":[0],"playable":true,"settings":{"start_scale":"Starting Size"}},
  "DF": {"name":"Deflate","type":"Fun","modes":[0],"playable":true,"settings":{"start_scale":"Starting Size"}},
  "WU": {"name":"Wind Up","type":"Fun","modes":[0,1,2,3],"playable":true,"settings":{"initial_rate":"Initial rate","final_rate":"Final rate","adjust_pitch":"Adjust pitch"}},
  "WD": {"name":"Wind Down","type":"Fun","modes":[0,1,2,3],"playable":true,"settings":{"initial_rate":"Initial rate","final_rate":"Final rate","adjust_pitch":"Adjust pitch"}},
  "FF": {"name":"Floating Fruits","type":"Fun","modes":[2],"playable":true,"settings":{}},
  "BR": {"name":"Barrel Roll","type":"Fun","modes":[0],"playable":true,"settings":{"spin_speed":"Roll speed","direction":"Direction"}},
  "AD": {"name":"Approach Different","type":"Fun","modes":[0],"playable":true,"settings":{"scale":"Initial size","style":"Style"}},
  "MU": {"name":"Muted","type":"Fun","modes":[0,1,2,3],"playable":true,"settings":{"inverse_muting":"Start muted","enable_metronome":"Enable metronome","mute_combo_count":"Final volume at combo","affects_hit_sounds":"Mute hit sounds"}},
  "NS": {"name":"No Scope","type":"Fun","modes":[0,2],"playable":true,"settings":{"hidden_combo_count":"Hidden at combo"}},
  "MF": {"name":"Moving Fast","type":"Fun","modes":[2],"playable":true,"settings":{}},
  "MG": {"name":"Magnetised","type":"Fun","modes":[0],"playable":true,"settings":{"attraction_strength":"Attraction strength"}},
  "RP": {"name":"Repel","type":"Fun","modes":[0],"playable":true,"settings":{"repulsion_strength":"Repulsion strength"}},
  "AS": {"name":"Adaptive Speed","type":"Fun","modes":[0,1,3],"playable":true,"settings":{"initial_rate":"Initial rate","adjust_pitch":"Adjust pitch"}},
  "FR": {"name":"Freeze Frame","type":"Fun","modes":[0],"playable":true,"settings":{}},
  "BU": {"name":"Bubbles","type":"Fun","modes":[0],"playable":true,"settings":{}},
  "SY": {"name":"Synesthesia","type":"Fun","modes":[0,2],"playable":true,"settings":{}},
  "DP": {"name":"Depth","type":"Fun","modes":[0],"playable":true,"settings":{"max_depth":"Maximum depth","show_approach_circles":"Show Approach Circles"}},
  "BM": {"name":"Bloom","type":"Fun","modes":[0],"playable":true,"settings":{"max_size_combo_count":"Max size at combo","max_cursor_size":"Final size multiplier"}},
  "TD": {"name":"Touch Device","type":"System","modes":[0],"playable":true,"settings":{}},
  "SV2": {"name":"Score V2","type":"System","modes":[0,1,2,3],"playable":false,"settings":{}},
};

/** Each ruleset's mods in osu-web's order, by this app's mode number. */
export const MOD_ORDER = {
  0: ["EZ","NF","HT","DC","HR","SD","PF","DT","NC","HD","TC","FL","BL","ST","AC","TP","DA","CL","RD","MR","AL","SG","AT","CN","RX","AP","SO","TR","WG","SI","GR","DF","WU","WD","BR","AD","MU","NS","MG","RP","AS","FR","BU","SY","DP","BM","TD","SV2"],
  1: ["EZ","NF","HT","DC","SR","HR","SD","PF","DT","NC","HD","FL","AC","RD","DA","CL","SW","SG","CS","AT","CN","RX","WU","WD","MU","AS","SV2"],
  2: ["EZ","NF","HT","DC","HR","SD","PF","DT","NC","HD","FL","AC","DA","CL","MR","AT","CN","RX","WU","WD","FF","MU","NS","MF","SY","SV2"],
  3: ["EZ","NF","HT","DC","NR","HR","SD","PF","DT","NC","FI","HD","CO","FL","AC","RD","DS","MR","DA","CL","IN","CS","HO","1K","2K","3K","4K","5K","6K","7K","8K","9K","10K","AT","CN","WU","WD","MU","AS","SV2"],
};
