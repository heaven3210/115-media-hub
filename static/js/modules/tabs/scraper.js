let scraperCorePromise = null;

function buildScraperCoreImportUrl() {
    const query = (() => {
        try {
            return new URL(import.meta.url).search || '';
        } catch (e) {
            return '';
        }
    })();
    return `/static/js/modules/scraper/core.js${query}`;
}

async function loadScraperCore() {
    if (!scraperCorePromise) {
        scraperCorePromise = import(buildScraperCoreImportUrl()).catch(() => null);
    }
    return scraperCorePromise;
}

export async function ensureTabData(context) {
    const core = await loadScraperCore();
    if (core?.ensureScraperManager) {
        await core.ensureScraperManager({
            firstVisit: !context.moduleVisitState.scraper,
        });
    }
    context.moduleVisitState.scraper = true;
}
