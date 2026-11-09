namespace OsuLocalProfiles.Tests;

/// <summary>
/// The languages a stored choice is checked against. That the page offers the same list, and the
/// translations themselves, are test/i18n.test.ts's.
/// </summary>
public sealed class I18nTests
{
    [Fact]
    public void A_language_code_is_checked_against_the_list_before_it_is_stored()
    {
        Assert.True(I18n.IsLocale("pt-br"));
        // osu!'s codes are lower case.
        Assert.False(I18n.IsLocale("PT-BR"));
        Assert.False(I18n.IsLocale("xx"));
        Assert.False(I18n.IsLocale(""));
        Assert.False(I18n.IsLocale((string?)null));
        // The whole list, translated or not: which locales ship a file is the page's business,
        // and a stored code starts working the day one lands.
        Assert.True(I18n.IsLocale("vi"));
        Assert.Equal("en", I18n.DefaultLocale);
    }
}
