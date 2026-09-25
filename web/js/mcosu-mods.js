/**
 * McOsu's own mods, which osu! has no equivalent of: its Nightmare mod and its experimental
 * mods. Filed under one badge, MC, rather than twenty-odd of their own, so the mod lists here
 * stay osu!'s. A play's MC carries which of them were on as settings, and the tooltip names
 * them. See src/clients/mcosu.ts.
 *
 * Not in mod-definitions.js, which is generated from osu-web and never edited.
 */

/** The MC badge, in the shape of a mod-definitions.js entry: a Fun mod, osu!standard only. */
export const MCOSU_DEFINITIONS = {
  MC: { name: 'McOsu', type: 'Fun', modes: [0], playable: true, settings: {} },
};

/** McOsu's own names for them, as its mod selector labels them (OsuModSelector.cpp). */
const NAMES = {
  nightmare: 'Nightmare',
  fposu_mod_strafing: 'FPoSu: Strafing',
  fposu_mod_3d_depthwobble: 'FPoSu 4D: Z Wobble',
  osu_mod_wobble: 'Wobble',
  osu_mod_wobble2: 'Wobble 2',
  osu_mod_arwobble: 'AR Wobble',
  osu_mod_approach_different: 'Approach Different',
  osu_mod_timewarp: 'Timewarp',
  osu_mod_artimewarp: 'AR Timewarp',
  osu_mod_minimize: 'Minimize',
  osu_mod_fadingcursor: 'Fading Cursor',
  osu_mod_fps: 'First Person',
  osu_mod_fullalternate: 'Full Alternate',
  osu_mod_jigsaw1: 'Jigsaw 1',
  osu_mod_jigsaw2: 'Jigsaw 2',
  osu_mod_random: 'Random',
  osu_mod_reverse_sliders: 'Reverse Sliders',
  osu_mod_no_spinners: 'No Spinners',
  osu_mod_no50s: 'No 50s',
  osu_mod_no100s: 'No 100s no 50s',
  osu_mod_ming3012: 'MinG3012',
  osu_mod_halfwindow: 'Half Timing Window',
  osu_mod_millhioref: 'MillhioreF',
  osu_mod_mafham: 'Mafham',
  osu_mod_strict_tracking: 'Strict Tracking',
  osu_mod_shirone: 'Shirone',
  osu_playfield_mirror_horizontal: 'Flip Up/Down',
  osu_playfield_mirror_vertical: 'Flip Left/Right',
};

/**
 * The McOsu mods an MC badge stands for, by name. One this list does not know -- from a newer
 * McOsu -- is shown by its console variable, less the prefix, rather than dropped.
 */
export function mcosuModNames(settings) {
  return Object.keys(settings ?? {})
    .filter((key) => settings[key] === true)
    .map((key) => NAMES[key] ?? key.replace(/^(osu|fposu)_(mod_)?/, ''));
}
