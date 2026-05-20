export async function ensureTabData(context) {
    if (!context.moduleVisitState.recommendation) {
        if (typeof initRecommendationPage === 'function') {
            await initRecommendationPage();
        }
        context.moduleVisitState.recommendation = true;
    }
}
