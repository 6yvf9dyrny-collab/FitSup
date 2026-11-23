import ActivityKit
import SwiftUI
import WidgetKit

@main
struct FitSupRestBundle: WidgetBundle {
    var body: some Widget { RestLiveActivity() }
}

/// Conto alla rovescia del recupero sulla schermata di blocco e nella Dynamic Island.
struct RestLiveActivity: Widget {
    private let green = Color(red: 0.20, green: 0.78, blue: 0.55)

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RestAttributes.self) { ctx in
            HStack(spacing: 12) {
                Image(systemName: "timer").font(.title2).foregroundStyle(green)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Recupero").font(.caption).foregroundStyle(.secondary)
                    Text(ctx.state.title).font(.subheadline).lineLimit(1)
                }
                Spacer()
                Text(timerInterval: Date()...max(Date(), ctx.state.end), countsDown: true)
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 130)
            }
            .padding()
            .activityBackgroundTint(Color.black.opacity(0.85))
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { ctx in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label("Recupero", systemImage: "timer").foregroundStyle(green)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(timerInterval: Date()...max(Date(), ctx.state.end), countsDown: true)
                        .monospacedDigit().font(.title2.bold()).frame(maxWidth: 90)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(ctx.state.title).font(.caption).lineLimit(1)
                }
            } compactLeading: {
                Image(systemName: "timer").foregroundStyle(green)
            } compactTrailing: {
                Text(timerInterval: Date()...max(Date(), ctx.state.end), countsDown: true)
                    .monospacedDigit().frame(maxWidth: 44)
            } minimal: {
                Image(systemName: "timer").foregroundStyle(green)
            }
        }
    }
}
