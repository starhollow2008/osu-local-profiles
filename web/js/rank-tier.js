/**
 * A global rank's tier, as osu-web colours it on a profile (issue #30): ported from osu-web's
 * `resources/js/profile-page/rank.tsx` (`globalTier`), and drawn by its `rank-value.less`
 * (`.rank-value` in web/css/profile.css) in the tier colours of its `layout.less`
 * (`--level-tier-*` in web/css/tokens.css).
 *
 * osu-web divides the rank by how many players the ruleset ranks. The app's rank is estimated
 * from a data.ppy.sh curve, so the count is the curve's own: its last place (`Players` in
 * dotnet/App/Calc/Rank.cs).
 */

/** The tier, or null for a rank in the bottom half, or with nothing to measure it against. */
export function rankTier(rank, players) {
  if (!Number.isFinite(rank) || rank < 1 || !Number.isFinite(players) || players < 1) return null;
  if (rank <= 100) return 'lustrous';
  const percent = rank / Math.max(1, players);
  return percent < 0.0005
    ? 'radiant'
    : percent < 0.0015
      ? 'rhodium'
      : percent < 0.005
        ? 'platinum'
        : percent < 0.015
          ? 'gold'
          : percent < 0.05
            ? 'silver'
            : percent < 0.15
              ? 'bronze'
              : percent < 0.5
                ? 'iron'
                : null;
}
