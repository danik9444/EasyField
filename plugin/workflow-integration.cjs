// Resolve owns and installs this native module. Public EasyField packages do
// not redistribute it: current installations load only the SDK SamplePlugin
// copy authenticated by the installer preflight.

const OFFICIAL_WORKFLOW_INTEGRATION_MODULE = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node';

function loadWorkflowIntegration(options = {}) {
    const load = options.load || require;
    const logger = options.logger || console;
    const candidates = [
        { kind: 'Resolve SDK', modulePath: OFFICIAL_WORKFLOW_INTEGRATION_MODULE },
    ];

    for (const candidate of candidates) {
        try {
            return load(candidate.modulePath);
        } catch (error) {
            logger.error(
                `[EasyField] ${candidate.kind} WorkflowIntegration.node failed to load:`,
                error && error.message,
            );
        }
    }

    logger.error(
        '[EasyField] WorkflowIntegration.node is unavailable. Reinstall DaVinci Resolve from Blackmagic Design.',
    );
    return null;
}

module.exports = Object.freeze({
    OFFICIAL_WORKFLOW_INTEGRATION_MODULE,
    loadWorkflowIntegration,
});
