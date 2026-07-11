import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct OnboardingAISetupTests {
    @Test func `candidate failure keeps friendly summary and exact detail`() {
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "auth",
            error: "Codex login expired (request 42)")

        #expect(failure.summary == "Codex CLI is installed, but the login didn’t work. Sign in again, then retry.")
        #expect(failure.detail == "Codex login expired (request 42)")
        #expect(failure.copyText == "Codex login expired (request 42)")
    }

    @Test func `candidate failure omits empty detail`() {
        let failure = OnboardingAISetupModel.failure(
            label: "Codex CLI",
            status: "timeout",
            error: "  ")

        #expect(failure.summary == "Codex CLI didn’t answer in time.")
        #expect(failure.detail == nil)
        #expect(failure.copyText == failure.summary)
    }

    @Test func `transport failure preserves original detail`() {
        let failure = OnboardingAISetupModel.transportFailure(
            "Gateway request failed: connection reset")

        #expect(failure.summary == "Gateway request failed: connection reset")
        #expect(failure.detail == "Gateway request failed: connection reset")
    }

    @Test func `codex activation covers install probe and finalization`() {
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "codex-cli") == 480_000)
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "claude-cli") == 150_000)
        #expect(OnboardingAISetupModel.activationRequestTimeoutMs(for: "codex-cli") >= (305 + 90) * 1000)
        #expect(OnboardingAISetupModel.activationOutcomeDeadlineMs(for: "codex-cli") == 510_000)
    }

    @Test func `incomplete detection is not a reconciled activation`() {
        #expect(!OnboardingAISetupModel.activationIsPersisted(
            expectedModel: "openai/gpt-5.5",
            setupComplete: false,
            configuredModel: nil))
        #expect(OnboardingAISetupModel.activationIsPersisted(
            expectedModel: "openai/gpt-5.5",
            setupComplete: true,
            configuredModel: "openai/gpt-5.5"))
    }

    @Test func `definitive gateway response does not enter reconciliation`() {
        let responseError = GatewayResponseError(
            method: "crestodian.setup.activate",
            code: "UNKNOWN_METHOD",
            message: "unknown method",
            details: nil)
        let timeout = NSError(
            domain: "Gateway",
            code: 5,
            userInfo: [NSLocalizedDescriptionKey: "gateway request timed out"])
        let decodeError = DecodingError.dataCorrupted(.init(
            codingPath: [],
            debugDescription: "invalid activation response"))

        #expect(OnboardingAISetupModel.activationReconciliationMode(after: responseError) == .none)
        #expect(OnboardingAISetupModel.activationReconciliationMode(after: decodeError) == .immediate)
        #expect(OnboardingAISetupModel.activationReconciliationMode(after: timeout) == .polling)
    }

    @Test func `legacy activation retry matches only the old strict schema rejection`() {
        let oldGatewayError = GatewayResponseError(
            method: "crestodian.setup.activate",
            code: "INVALID_REQUEST",
            message: "invalid crestodian.setup.activate params: at root: unexpected property 'acknowledgeNonClawHubInstall'",
            details: nil)
        let unrelatedError = GatewayResponseError(
            method: "crestodian.setup.activate",
            code: "INVALID_REQUEST",
            message: "invalid crestodian.setup.activate params: at /kind: must be string",
            details: nil)

        #expect(OnboardingAISetupModel.activationNeedsLegacyAcknowledgementRetry(after: oldGatewayError))
        #expect(!OnboardingAISetupModel.activationNeedsLegacyAcknowledgementRetry(after: unrelatedError))
    }

    @Test func `gateway change clears route-bound setup state`() {
        let model = OnboardingAISetupModel()
        model.manualProviderID = "openai"
        model.manualKey = "temporary-key"
        model.showManualEntry = true
        model.userSelect(kind: "codex-cli")

        model.resetForGatewayChange()

        #expect(model.phase == .idle)
        #expect(model.connectedModelRef == nil)
        #expect(model.connectedLatencyMs == nil)
        #expect(model.manualProviderID.isEmpty)
        #expect(model.manualKey.isEmpty)
        #expect(!model.showManualEntry)
        #expect(model.pendingNonClawHubCandidateKind == nil)
    }

    @Test func `codex selection requires explicit non clawhub confirmation`() {
        let model = OnboardingAISetupModel()

        model.userSelect(kind: "codex-cli")

        #expect(model.pendingNonClawHubCandidateKind == "codex-cli")
        #expect(model.phase == .idle)

        model.cancelNonClawHubActivation()

        #expect(model.pendingNonClawHubCandidateKind == nil)
    }

    @Test func `untried codex remains available after an automatic candidate fails`() {
        let candidates = [
            OnboardingAISetupModel.Candidate(
                kind: "codex-cli",
                label: "Codex CLI",
                detail: "Signed in",
                modelRef: "openai/gpt-5.5",
                recommended: false,
                credentials: true),
            OnboardingAISetupModel.Candidate(
                kind: "claude-cli",
                label: "Claude Code",
                detail: "Signed in",
                modelRef: "anthropic/claude-sonnet-4-5",
                recommended: true,
                credentials: true),
        ]

        #expect(OnboardingAISetupModel.hasUntriedConsentGatedCodex(
            candidates: candidates,
            statuses: [
                "claude-cli": .failed(.init(summary: "Failed", detail: nil)),
                "codex-cli": .untried,
            ]))
        #expect(!OnboardingAISetupModel.hasUntriedConsentGatedCodex(
            candidates: candidates,
            statuses: [
                "claude-cli": .failed(.init(summary: "Failed", detail: nil)),
                "codex-cli": .failed(.init(summary: "Failed", detail: nil)),
            ]))
    }

    @Test func `optional setup acknowledgement preserves the existing initializer`() {
        let params = CrestodianSetupActivateParams(
            kind: AnyCodable("claude-cli"),
            authchoice: nil,
            apikey: nil,
            workspace: nil)

        #expect(params.acknowledgenonclawhubinstall == nil)
    }
}
