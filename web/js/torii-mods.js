/**
 * The mods two osu!lazer forks add, in the shape of mod-definitions.js entries: Torii's
 * (ShikkesoraSIM/torii-osu) and Ritsu's (Azuuryy/ritsu, built on Torii, with Modosu's training
 * mods). Names, types and setting labels are theirs, read from their source. Setting keys are
 * lazer's: each setting's property name in snake_case. See dotnet/App/Clients/Torii.cs.
 *
 * Not in mod-definitions.js, which is generated from osu-web and never edited.
 */

/** Every Torii and Ritsu mod but Miss Challenge, whose acronym is McOsu's MC here. */
export const TORII_DEFINITIONS = {
  HST: { name: 'Streamline', type: 'DifficultyReduction', modes: [0], playable: true, settings: {} },
  NL: {
    name: 'No Sliding', type: 'DifficultyIncrease', modes: [0], playable: true,
    settings: {
      target: 'Sliders to convert',
      conversion: 'Conversion',
      short_slider_threshold: 'Short slider threshold (ms)',
      beat_divisor: 'Beat divisor',
      deathstreams_slowing_down: 'Slow down too long streams',
      fast_parts_slowing_down: 'Slow down too fast parts',
    },
  },
  HFR: { name: 'One Eye', type: 'DifficultyIncrease', modes: [0], playable: true, settings: {} },
  DFK: { name: 'Directional Flicks', type: 'DifficultyIncrease', modes: [0], playable: true, settings: {} },
  DCY: {
    name: 'Decoy Circles', type: 'DifficultyIncrease', modes: [0], playable: true,
    settings: {
      interval_beats: 'Minimum interval (beats)',
      minimum_note_spacing: 'Minimum note spacing (beats)',
      style: 'Decoy appearance',
      number: 'Decoy number',
    },
  },
  RSL: { name: 'Reversed Sliders', type: 'DifficultyIncrease', modes: [0], playable: true, settings: {} },
  CG: {
    name: 'Circle Generation', type: 'Conversion', modes: [0], playable: true,
    settings: {
      divisor: 'Divisor',
      distance: 'Distance',
      break_distance: 'Break distance',
      break: 'Include breaks?',
      break_interval: 'Break interval',
      break_objects: 'Break duration (in hitobjects)',
      full_map: 'Full map?',
      offset: 'Offset (in circles)',
      count: 'Hitobjects count',
      increasing: 'Increasing?',
      kickslider: 'Kickslider',
    },
  },
  RDV2: {
    name: 'RandomV2', type: 'Conversion', modes: [0], playable: true,
    settings: {
      seed: 'Seed',
      remove_stacks: 'Remove stacks',
      aim_distance_multiplier: 'Aim Distance Multiplier',
      expo_jumps: 'Exponential jumps',
      stream_distance_multiplier: 'Stream Distance Multiplier',
      expo_streams: 'Exponential streams',
      divisor: 'Aim/Stream Divisor',
      custom_angle: 'Custom angle',
      pattern_mask: 'Patterns',
      angle: 'Angle without patterns',
      angle_sharpness: 'Angle sharpness',
      stream_angle_sharpness: 'Stream Angle sharpness',
    },
  },
  SA: {
    name: 'Spacing Adjust', type: 'Conversion', modes: [0], playable: true,
    settings: { object_spacing: 'Object spacing', maximum_jump_distance: 'Maximum jump distance' },
  },
  SOT: {
    name: 'Spacing Overtime', type: 'Conversion', modes: [0], playable: true,
    settings: { start_spacing: 'Starting spacing', end_spacing: 'Ending spacing' },
  },
  ME: { name: 'Metronome', type: 'Fun', modes: [0], playable: true, settings: { tempo_scale: 'Tempo scale' } },
  HS: {
    name: 'Hit Sounder', type: 'Fun', modes: [0], playable: true,
    settings: { bank: 'Sample set', use_note_samples: 'Keep note hitsounds' },
  },
  PA: {
    name: 'Pitch Adjust', type: 'Fun', modes: [0, 1, 2, 3], playable: true,
    settings: { pitch_shift: 'Pitch shift', extended_limits: 'Extended limits' },
  },
  PMR: { name: 'Phrase Mirror', type: 'System', modes: [0], playable: true, settings: {} },
  ECH: { name: 'Echo', type: 'System', modes: [0], playable: true, settings: {} },
  SWG: { name: 'Swing', type: 'System', modes: [0], playable: true, settings: {} },
};

/** Ritsu's Miss Challenge, which is MC on a play osu! does not score as stable. */
export const MISS_CHALLENGE = {
  name: 'Miss Challenge', type: 'DifficultyIncrease', modes: [0], playable: true,
  settings: { use_best_local_score: 'Use best local score', max_misses: 'Max misses' },
};
