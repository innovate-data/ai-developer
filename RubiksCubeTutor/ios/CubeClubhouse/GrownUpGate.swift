//
//  Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
//  Proprietary software. See LICENSE, or the Licence page inside the app.
//

import SwiftUI

/// A question for a grown-up before the app opens anything outside itself. The only thing
/// behind it is the App Store sheet that "Update" opens (UpdateChecker), because the App
/// Store is a shop.
///
/// It asks for the answer to a times-table sum between 6 x 6 and 9 x 9, typed on its own
/// keypad: there is no text field, so nothing can be typed except two digits, and nothing
/// typed is kept. A wrong answer brings a new sum. Cancel closes it, and nothing opens.
struct GrownUpGate: View {
    let onPass: () -> Void
    let onCancel: () -> Void

    @State private var a = Int.random(in: 6...9)
    @State private var b = Int.random(in: 6...9)
    @State private var typed = ""
    @State private var wrong = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Text("For Grown-Ups")
                    .font(.title2.bold())
                Text("The App Store is a shop, so a grown-up opens it. Type the answer to open it.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Text("\(a) × \(b) = \(typed.isEmpty ? "?" : typed)")
                    .font(.system(size: 40, weight: .bold, design: .rounded))
                    .accessibilityLabel("\(a) times \(b) equals \(typed.isEmpty ? "blank" : typed)")
                if wrong {
                    Text("Not quite. Here is another one.")
                        .foregroundStyle(.red)
                }
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(76)), count: 3), spacing: 12) {
                    ForEach(1...9, id: \.self) { n in key(n) }
                    Color.clear.frame(width: 76, height: 56)
                    key(0)
                    Button {
                        if !typed.isEmpty { typed.removeLast() }
                    } label: {
                        Image(systemName: "delete.left")
                            .font(.title2)
                            .frame(width: 76, height: 56)
                    }
                    .accessibilityLabel("Delete")
                }
            }
            .padding(24)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
        .interactiveDismissDisabled()
    }

    private func key(_ digit: Int) -> some View {
        Button {
            guard typed.count < 2 else { return }
            typed += String(digit)
            if typed.count == 2 { check() }
        } label: {
            Text(String(digit))
                .font(.title.bold())
                .frame(width: 76, height: 56)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }

    private func check() {
        if Int(typed) == a * b {
            onPass()
        } else {
            wrong = true
            typed = ""
            a = Int.random(in: 6...9)
            b = Int.random(in: 6...9)
        }
    }
}
