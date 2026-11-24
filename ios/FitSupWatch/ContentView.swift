import SwiftUI

struct ContentView: View {
    @EnvironmentObject var m: WatchModel
    @State private var asking = false

    var body: some View {
        NavigationStack {
            Group {
                if let st = m.state, st.on, let ex = m.current {
                    workout(st, ex)
                } else {
                    empty
                }
            }
            .navigationTitle("FitSup")
        }
        .sheet(isPresented: $asking) {
            if let ex = m.current, let j = ex.nextSet {
                RepsView(ex: ex, j: j) { reps, w in
                    asking = false
                    m.setDone(reps: reps, weight: w)
                }
            }
        }
    }

    private var empty: some View {
        ScrollView {
            VStack(spacing: 10) {
                if let d = m.state?.done, !d.isEmpty {
                    Text("✓ Allenamento completato").font(.headline).foregroundStyle(.green)
                    Text(d).font(.footnote).foregroundStyle(.secondary)
                } else {
                    Image(systemName: "iphone").font(.title2)
                    Text("Apri FitSup sull'iPhone, in Oggi.").multilineTextAlignment(.center).font(.footnote)
                }
                Button("Aggiorna") { m.refresh() }
            }
        }
    }

    private func workout(_ st: WState, _ ex: WEx) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                if (st.started ?? 0) == 0 {
                    Button { m.startWorkout() } label: { Label("Avvia allenamento", systemImage: "play.fill") }
                        .tint(.green)
                }
                if !ex.ss.isEmpty {
                    Text("SUPERSERIE \(ex.ss)").font(.caption2.bold()).foregroundStyle(.green)
                }
                Text(ex.n).font(.headline).lineLimit(3)
                Text(info(ex)).font(.footnote).foregroundStyle(.secondary)

                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    if m.resting {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Recupero").font(.caption).foregroundStyle(.secondary)
                            Text(timerInterval: Date()...Date(timeIntervalSince1970: m.restEnd / 1000), countsDown: true)
                                .font(.system(size: 40, weight: .semibold, design: .rounded)).monospacedDigit()
                                .foregroundStyle(.green)
                            Button("Salta recupero") { m.skipRest() }
                        }
                    } else if ex.finished {
                        Label("Esercizio finito", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                    } else {
                        Button { asking = true } label: {
                            Text("Serie finita").font(.title3.bold()).frame(maxWidth: .infinity)
                        }
                        .tint(.green)
                        .buttonStyle(.borderedProminent)
                    }
                }

                HStack {
                    Button { m.move(-1) } label: { Image(systemName: "chevron.left") }
                    Text("\(m.pos + 1)/\(m.exercises.count)").font(.footnote).frame(maxWidth: .infinity)
                    Button { m.move(1) } label: { Image(systemName: "chevron.right") }
                }
                if !st.label.isNilOrEmpty {
                    Text(st.label!).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func info(_ ex: WEx) -> String {
        let done = ex.s.filter { $0.d == 1 }.count
        var t = ex.finished ? "\(ex.s.count) serie fatte" : "Serie \(min(done + 1, ex.s.count)) di \(ex.s.count)"
        if let j = ex.nextSet, !ex.s[j].w.isEmpty { t += " · \(ex.s[j].w) \(ex.u)" }
        t += ex.min == ex.max ? " · \(ex.min) rep" : " · \(ex.min)–\(ex.max) rep"
        return t
    }
}

/// Ripetizioni fatte (partono dal minimo del range) e, se serve, il peso.
struct RepsView: View {
    let ex: WEx
    let j: Int
    let onSave: (Int, String?) -> Void
    @State private var reps: Double = 8
    @State private var weight: Double = 0
    @State private var hasWeight = false
    @State private var weightChanged = false

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                Text("Serie \(j + 1) · ripetizioni").font(.footnote).foregroundStyle(.secondary)
                HStack {
                    Button { reps = max(0, reps - 1) } label: { Image(systemName: "minus") }
                    Text("\(Int(reps))").font(.system(size: 44, weight: .bold, design: .rounded)).frame(minWidth: 60)
                        .focusable()
                        .digitalCrownRotation($reps, from: 0, through: 100, by: 1, sensitivity: .low, isContinuous: false, isHapticFeedbackEnabled: true)
                    Button { reps = min(100, reps + 1) } label: { Image(systemName: "plus") }
                }
                if hasWeight {
                    HStack {
                        Button { weight = max(0, weight - step); weightChanged = true } label: { Image(systemName: "minus") }
                        Text("\(fmt(weight)) \(ex.u)").font(.headline).frame(maxWidth: .infinity)
                        Button { weight += step; weightChanged = true } label: { Image(systemName: "plus") }
                    }
                }
                Button { onSave(Int(reps), weightChanged ? fmt(weight) : nil) } label: {
                    Text("Salva").font(.headline).frame(maxWidth: .infinity)
                }
                .tint(.green).buttonStyle(.borderedProminent)
            }
        }
        .onAppear {
            reps = Double(ex.min)
            let w = ex.s[j].w.replacingOccurrences(of: ",", with: ".")
            if let v = Double(w) { weight = v; hasWeight = true }
        }
    }

    private var step: Double { ex.u == "lb" ? 5 : 2.5 }
    private func fmt(_ v: Double) -> String {
        v.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(v)) : String(format: "%.1f", v).replacingOccurrences(of: ".", with: ",")
    }
}

private extension Optional where Wrapped == String {
    var isNilOrEmpty: Bool { self?.isEmpty ?? true }
}
