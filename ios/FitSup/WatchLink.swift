import Foundation
import WatchConnectivity
import WebKit

/// Ponte tra il sito (dentro la WKWebView) e l'app dell'Apple Watch.
/// Sito → orologio: lo stato di Oggi (esercizi, serie, recupero) come JSON.
/// Orologio → sito: «Serie finita», «Avvia allenamento», «Salta recupero», cambio esercizio.
final class WatchLink: NSObject, WCSessionDelegate {
    static let shared = WatchLink()
    weak var web: WKWebView?
    private var lastState: String?

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// true quando l'app dell'orologio è aperta adesso: il fine recupero lo fa vibrare lei.
    var watchIsActive: Bool {
        WCSession.isSupported() && WCSession.default.activationState == .activated && WCSession.default.isReachable
    }

    /// Stato di Oggi arrivato dal sito: va all'orologio (subito se è aperto, altrimenti alla prossima apertura).
    func send(stateJSON: String) {
        lastState = stateJSON
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        guard s.activationState == .activated, s.isPaired, s.isWatchAppInstalled else { return }
        try? s.updateApplicationContext(["state": stateJSON])
        if s.isReachable { s.sendMessage(["state": stateJSON], replyHandler: nil, errorHandler: nil) }
    }

    /// Comando dall'orologio: lo passa al sito, che risponde mandando lo stato aggiornato.
    private func toSite(_ cmd: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: cmd),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            self.web?.evaluateJavaScript("window.fitsupWatch&&window.fitsupWatch(\(json))", completionHandler: nil)
        }
    }

    // MARK: WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        if state == .activated { toSite(["type": "hello"]) }
    }
    func sessionReachabilityDidChange(_ session: WCSession) {
        if session.isReachable { toSite(["type": "hello"]) }
    }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        toSite(message)
    }
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        toSite(message)
        replyHandler(["ok": true])
    }
    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        toSite(userInfo)
    }
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
