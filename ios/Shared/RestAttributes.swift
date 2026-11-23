import ActivityKit
import Foundation

/// Dati della Live Activity del recupero, condivisi tra l'app e il widget.
struct RestAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var end: Date
        var title: String
    }
    var name: String
}
