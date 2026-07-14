// Resolve owns and installs this native module. Public EasyField packages do
// not redistribute it: current installations load the SDK SamplePlugin copy.
// The bundled path remains first only so older local EasyField installations
// can continue to start while they transition to the external module.

const path = require('path');

const LEGACY_WORKFLOW_INTEGRATION_MODULE = path.join(__dirname, 'WorkflowIntegration.node');
const OFFICIAL_WORKFLOW_INTEGRATION_MODULE = '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node';

function loadWorkflowIntegration(options = {}) {
    const load = options.load || require;
    const logger = options.logger || console;
    const candidates = [
        { kind: 'bundled legacy', modulePath: LEGACY_WORKFLOW_INTEGRATION_MODULE },
        { kind: 'Resolve SDK', modulePath: OFFICIAL_WORKFLOW_INTEGRATION_MODULE },
    ];

    for (const candidate of candidates) {
        try {
            return load(candidate.modulePath);
        } catch (error) {
            // A missing legacy module is the normal state for current builds.
            // Other failures are useful diagnostics before trying Resolve's
            // official copy.
            if (!(candidate.kind === 'bundled legacy' && error && error.code === 'MODULE_NOT_FOUND')) {
                logger.error(
                    `[EasyField] ${candidate.kind} WorkflowIntegration.node failed to load:`,
                    error && error.message,
                );
            }
        }
    }

    logger.error(
        '[EasyField] WorkflowIntegration.node is unavailable. Reinstall DaVinci Resolve from Blackmagic Design.',
    );
    return null;
}

module.exports = Object.freeze({
    LEGACY_WORKFLOW_INTEGRATION_MODULE,
    OFFICIAL_WORKFLOW_INTEGRATION_MODULE,
    loadWorkflowIntegration,
});
