import fs from 'node:fs';
import { installMessages } from '../web/js/i18n.js';

/**
 * Put the page's English in place, for a test that checks wording the page builds.
 *
 * The page's text now comes from `web/i18n/en.json` rather than from literals scattered
 * through the modules, and in the app `useLocale` fetches it before anything is drawn. A test
 * has no fetch and no page, so it reads the same file off disk. Importing this module is
 * enough; there is nothing to call.
 *
 * Without it, `t('judgement.great')` returns `judgement.great` -- which is the correct
 * behaviour for a key with no language loaded, and makes for a baffling assertion failure.
 */
installMessages(JSON.parse(fs.readFileSync('web/i18n/en.json', 'utf8')) as Record<string, string>);
