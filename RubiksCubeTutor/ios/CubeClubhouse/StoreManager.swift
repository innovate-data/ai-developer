//
//  Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
//  Proprietary software. See LICENSE, or the Licence page inside the app.
//

import Foundation
import StoreKit

/// The one purchase in the app: step-by-step help for a 3x3 and bigger.
///
/// StoreKit is the only thing that decides whether it has been bought. The web app
/// keeps a copy of the answer so the screen looks right straight away, but this class
/// re-checks the entitlement on every launch and pushes the result into the page, so a
/// copy that has been tampered with is corrected within a second of opening the app.
@MainActor
final class StoreManager: ObservableObject {
    static let productID = "com.iralearning.cubeclubhouse.solver"

    @Published private(set) var isUnlocked = false
    @Published private(set) var product: Product?

    /// Called whenever the answer changes, so the web view can be told.
    var onChange: ((_ unlocked: Bool, _ price: String?, _ ready: Bool) -> Void)?

    private var updates: Task<Void, Never>?

    init() {
        // Purchases made elsewhere (another device, Ask to Buy approved later, a refund)
        // arrive here rather than through a button press.
        updates = Task(priority: .background) { [weak self] in
            for await update in Transaction.updates {
                await self?.handle(update)
            }
        }
    }

    deinit { updates?.cancel() }

    var priceText: String? { product?.displayPrice }

    /// Load the product and check what this Apple ID already owns.
    func start() async {
        await loadProduct()
        await refreshEntitlement()
    }

    private func loadProduct() async {
        do {
            product = try await Product.products(for: [Self.productID]).first
        } catch {
            product = nil            // no network, or the product is not live yet
        }
        notify()
    }

    /// Ask StoreKit what is owned. This is the check that matters.
    func refreshEntitlement() async {
        var owned = false
        for await entitlement in Transaction.currentEntitlements {
            if case .verified(let transaction) = entitlement,
               transaction.productID == Self.productID,
               transaction.revocationDate == nil {
                owned = true
            }
        }
        isUnlocked = owned
        notify()
    }

    enum Outcome {
        case bought
        case cancelled
        case pending             // Ask to Buy: a parent has to approve it
        case nothingToRestore
        case unavailable         // no product loaded
        case failed(String)
    }

    func purchase() async -> Outcome {
        guard let product else {
            await loadProduct()
            guard product != nil else { return .unavailable }
            return await purchase()
        }
        do {
            switch try await product.purchase() {
            case .success(let verification):
                switch verification {
                case .verified(let transaction):
                    await transaction.finish()
                    await refreshEntitlement()
                    return .bought
                case .unverified:
                    return .failed("That purchase could not be verified.")
                }
            case .userCancelled:
                return .cancelled
            case .pending:
                return .pending
            @unknown default:
                return .failed("The shop gave an answer this app does not understand.")
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    /// Bring back a purchase made on another device or before the app was reinstalled.
    func restore() async -> Outcome {
        do {
            try await AppStore.sync()
        } catch {
            // A cancelled sign-in sheet lands here; fall through and check anyway.
        }
        await refreshEntitlement()
        return isUnlocked ? .bought : .nothingToRestore
    }

    private func handle(_ result: VerificationResult<Transaction>) async {
        if case .verified(let transaction) = result {
            await transaction.finish()
            await refreshEntitlement()
        }
    }

    private func notify() {
        onChange?(isUnlocked, priceText, product != nil)
    }
}
