/**
 * neomod's own mods, which osu! has no equivalent of: the experimental mods it kept from McOsu
 * and added since, and its FPoSu. Filed under one badge, NEO, as McOsu's are under MC. A play's
 * NEO carries which of them were on as settings, and the tooltip names them. The ones osu!lazer
 * has (Mirror, Singletap, Alternate, Traceable, Strict Tracking, Freeze Frame, Approach
 * Different) are shown as osu!'s own. See dotnet/App/Clients/Neomod.cs.
 *
 * Not in mod-definitions.js, which is generated from osu-web and never edited.
 */

/** The NEO badge, in the shape of a mod-definitions.js entry: a Fun mod, osu!standard only. */
export const NEOMOD_DEFINITIONS = {
  NEO: { name: 'neomod', type: 'Fun', modes: [0], playable: true, settings: {} },
};

/** neomod's own names for them, as its mod selector and its features page give them. */
const NAMES = {
  nightmare: 'Nightmare',
  fposu: 'FPoSu',
  fposu_strafing: 'FPoSu: Strafing',
  timewarp: 'Timewarp',
  ar_timewarp: 'AR Timewarp',
  minimize: 'Minimize',
  strict_clicks: 'Strict clicks',
  precise_sliders: 'Precise sliders',
  wobble: 'Wobble',
  wobble2: 'Wobble 2',
  ar_wobble: 'AR Wobble',
  shirone: 'Shirone',
  mafham: 'Mafham',
  half_timing_window: 'Half Timing Window',
  ming3012: 'MinG3012',
  no_100s: 'No 100s no 50s',
  no_50s: 'No 50s',
  fading_cursor: 'Fading Cursor',
  first_person: 'First Person',
  reverse_sliders: 'Reverse Sliders',
  millhioref: 'MillhioreF',
  no_keylock: 'No keylock',
  no_pausing: 'No pausing',
  dks: 'DKS',
  no_hp: 'No HP drain',
  ar_lock: 'AR locked to speed',
  od_lock: 'OD locked to speed',
  no_note_lock: 'No note lock',
  neomod_note_lock: 'neomod note lock',
  lazer_note_lock: 'osu!lazer 2020 note lock',
};

/** The neomod mods a NEO badge stands for, by name. One this list does not know is shown by its key. */
export function neomodModNames(settings) {
  return Object.keys(settings ?? {})
    .filter((key) => settings[key] === true)
    .map((key) => NAMES[key] ?? key);
}
