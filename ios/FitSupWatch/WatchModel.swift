import Foundation
import WatchConnectivity
import WatchKit
import UserNotifications

// Stato mandato dal sito (funzione wState in index.html).
struct WSet: Codable { var w: String; var r: String; var pr: String; var d: Int }
struct WEx: Codable, Identifiable {
    var i: Int; var n: String; var u: String; var ss: String; var min: Int; var max: Int; var rec: Int; var s: [WSet]
    var id: Int { i }
    var nextSet: Int? { s.firstIndex { $0.d == 0 } }
    var finished: Bool { !s.isEmpty && nextSet == nil }
}
struct WState: Codable {
    var on: Bool
    var label: String?
    var started: Int?
    var done: String?
    var cur: Int?
    var rest: Double?
    var restName: String?
    var ex: [WEx]?
    var ts: Double?
}

@MainActor
final class WatchModel: NSObject, ObservableObject {
    @Published var state: WState?
    /// Posizione (nell'elenco ex) dell'esercizio mostrato.
    @Published var pos: Int = 0
    /// Fine del recupero (epoch ms); 0 = nessun recupero.
    @Published var restEnd: Double = 0
    @Published var restName: String = ""
    @Published var phoneReachable = false

    /// «Serie finita» mandate all'iPhone e non ancora viste nel suo stato: restano spuntate qui.
    private var pending: [(i: Int, j: Int, t: Date)] = []
    private var hapticTask: Task<Void, Never>?
    private var lastPhoneRest: Double = 0

    override init() {
        super.init()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    var exercises: [WEx] { state?.ex ?? [] }
    var current: WEx? { exercises.indices.contains(pos) ? exercises[pos] : nil }
    var resting: Bool { restEnd > Date().timeIntervalSince1970 * 1000 }

    // MARK: Stato dall'iPhone

    fileprivate func receive(json: String) {
        guard let data = json.data(using: .utf8), var st = try? JSONDecoder().decode(WState.self, from: data) else { return }
        let oldCur = state?.cur
        // Le serie segnate qui e non ancora arrivate al telefono restano segnate.
        pending.removeAll { p in
            Date().timeIntervalSince(p.t) > 600 ||
            (st.ex?.first { $0.i == p.i }.map { p.j < $0.s.count && $0.s[p.j].d == 1 } ?? false)
        }
        for p in pending {
            if let k = st.ex?.firstIndex(where: { $0.i == p.i }), p.j < st.ex![k].s.count { st.ex![k].s[p.j].d = 1 }
        }
        state = st
        // Recupero: quello del telefono vince; se il telefono l'ha fermato, si ferma anche qui.
        let phoneRest = st.rest ?? 0
        if phoneRest > 0 { setRest(phoneRest, name: st.restName ?? "") }
        else if lastPhoneRest > 0 && pending.isEmpty { setRest(0, name: "") }
        lastPhoneRest = phoneRest
        // Esercizio mostrato: segue quello aperto sul telefono quando cambia lì.
        if pending.isEmpty, let c = st.cur, c != oldCur, let k = exercises.firstIndex(where: { $0.i == c }) { pos = k }
        if pos >= exercises.count { pos = max(0, exercises.count - 1) }
    }

    // MARK: Azioni dall'orologio

    func refresh() { send(["type": "hello"]) }
    func startWorkout() { send(["type": "start"]) }

    func move(_ d: Int) {
        guard !exercises.isEmpty else { return }
        pos = (pos + d + exercises.count) % exercises.count
        send(["type": "open", "i": exercises[pos].i])
    }

    func skipRest() {
        setRest(0, name: "")
        send(["type": "restStop"])
    }

    /// «Serie finita»: la segna subito qui, la manda all'iPhone e fa partire il recupero.
    func setDone(reps: Int, weight: String?) {
        guard var st = state, var ex = current, let j = ex.nextSet, let k = st.ex?.firstIndex(where: { $0.i == ex.i }) else { return }
        ex.s[j].d = 1
        ex.s[j].r = String(reps)
        if let w = weight { ex.s[j].w = w }
        st.ex![k] = ex
        state = st
        pending.append((ex.i, j, Date()))
        var msg: [String: Any] = ["type": "done", "i": ex.i, "j": j, "r": String(reps)]
        if let w = weight { msg["w"] = w }
        send(msg)
        WKInterfaceDevice.current().play(.success)

        // Superserie: subito il prossimo esercizio del blocco, recupero dopo l'ultimo.
        let list = st.ex!
        if !ex.ss.isEmpty {
            let group = list.indices.filter { list[$0].ss == ex.ss }
            if let nx = group.first(where: { $0 > k && !list[$0].finished }) { pos = nx; return }
            startLocalRest(ex)
            if let first = group.first(where: { !list[$0].finished }) { pos = first; return }
        } else {
            startLocalRest(ex)
            if !list[k].finished { return }
        }
        if let nx = (list.indices.filter { $0 > k } + list.indices.filter { $0 <= k }).first(where: { !list[$0].finished }) { pos = nx }
    }

    private func startLocalRest(_ ex: WEx) {
        setRest(Date().timeIntervalSince1970 * 1000 + Double(max(ex.rec, 10)) * 1000, name: ex.n)
    }

    /// Imposta il recupero: notifica locale all'ora esatta (anche a schermo spento) + vibrazione se l'app è aperta.
    private func setRest(_ end: Double, name: String) {
        if abs(end - restEnd) < 1500 && name == restName { return }
        restEnd = end
        restName = name
        hapticTask?.cancel()
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ["fitsup.rest"])
        let secs = (end / 1000) - Date().timeIntervalSince1970
        guard end > 0, secs > 0 else { return }
        let content = UNMutableNotificationContent()
        content.title = "Recupero finito"
        content.body = name.isEmpty ? "Vai con la prossima serie." : "Prossima serie: \(name)"
        content.sound = .default
        center.add(UNNotificationRequest(identifier: "fitsup.rest", content: content,
                                         trigger: UNTimeIntervalNotificationTrigger(timeInterval: max(1, secs), repeats: false)))
        hapticTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(secs * 1_000_000_000))
            guard !Task.isCancelled else { return }
            WKInterfaceDevice.current().play(.notification)
            self?.objectWillChange.send()
        }
    }

    private func send(_ msg: [String: Any]) {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        guard s.activationState == .activated else { return }
        if s.isReachable {
            s.sendMessage(msg, replyHandler: nil) { _ in s.transferUserInfo(msg) }
        } else if msg["type"] as? String != "hello" && msg["type"] as? String != "open" {
            s.transferUserInfo(msg) // arriva all'iPhone appena può, anche se adesso è in tasca
        }
    }
}

extension WatchModel: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        let ctx = session.receivedApplicationContext["state"] as? String
        let reach = session.isReachable
        Task { @MainActor in
            if let ctx { self.receive(json: ctx) }
            self.phoneReachable = reach
            self.refresh()
        }
    }
    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        let reach = session.isReachable
        Task { @MainActor in self.phoneReachable = reach; if reach { self.refresh() } }
    }
    nonisolated func session(_ session: WCSession, didReceiveApplicationContext ctx: [String: Any]) {
        guard let json = ctx["state"] as? String else { return }
        Task { @MainActor in self.receive(json: json) }
    }
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        guard let json = message["state"] as? String else { return }
        Task { @MainActor in self.receive(json: json) }
    }
}
