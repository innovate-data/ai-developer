//
//  Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
//  Proprietary software. See LICENSE, or the Licence page inside the app.
//

import Foundation
import StoreKit
import UIKit

/// Asks the App Store whether a newer version of Cube Clubhouse is out, and offers it.
///
/// This is the one request the app ever makes, so it is kept as small as it can be:
///
/// - It goes only to Apple's own App Store lookup service, `itunes.apple.com/lookup`,
///   over HTTPS, and carries only the app's bundle identifier and the device's country or
///   region (so it looks in the right store). No names, no identifiers, no progress.
/// - It is made by the app, not the web page. The page still loads nothing from the
///   internet: its Content-Security-Policy and WebAppView's content rule list are
///   untouched.
/// - An ephemeral session: no cookies sent or kept, no cache written to disk.
/// - At most once a day, at launch, and never at all when the switch on the About page
///   is off. "Check Now" on that page asks straight away.
/// - A newer version is offered with an ordinary alert. "Not Now" keeps quiet about that
///   version for a week. "Update" opens the App Store's own sheet inside the app, so a
///   child is not sent out of it.
///
/// All it keeps, in UserDefaults, is whether the check is on, when it last worked, and a
/// version someone said "Not Now" to. The Privacy page and PrivacyInfo.xcprivacy say so.
final class UpdateChecker: NSObject, ObservableObject, SKStoreProductViewControllerDelegate {
    static let shared = UpdateChecker()

    /// A version in the store that is newer than this one and can be installed here.
    struct Release: Equatable {
        let version: String
        let appID: Int
    }

    /// What a check found, as the About page reports it.
    enum Outcome: String {
        case newer
        case upToDate = "up-to-date"
        case unavailable
    }

    /// The release to offer. RootView shows the alert while this is set.
    @Published private(set) var offer: Release?

    static let lookupURL = "https://itunes.apple.com/lookup"
    static let checkEvery: TimeInterval = 24 * 60 * 60           // a day
    static let quietAfterNotNow: TimeInterval = 7 * 24 * 60 * 60  // a week

    private let defaults = UserDefaults.standard
    private enum Key {
        static let enabled = "updates.enabled"
        static let lastCheck = "updates.lastCheck"
        static let notNowVersion = "updates.notNowVersion"
        static let notNowDate = "updates.notNowDate"
    }

    /// The switch on the About page. On unless someone turns it off.
    var enabled: Bool {
        get { defaults.object(forKey: Key.enabled) as? Bool ?? true }
        set { defaults.set(newValue, forKey: Key.enabled) }
    }

    /// The version people see, from the build settings (MARKETING_VERSION).
    var installedVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    // MARK: - Checking

    /// At launch: ask if the switch is on and the last good check was over a day ago,
    /// and offer what it finds unless someone said "Not Now" to it this week.
    func checkIfDue() {
        guard enabled else { return }
        if let last = defaults.object(forKey: Key.lastCheck) as? Date,
           Date().timeIntervalSince(last) < Self.checkEvery { return }
        lookUp { [weak self] outcome, release in
            guard let self = self, outcome == .newer, let release = release,
                  !self.saidNotNow(to: release.version) else { return }
            self.offer = release
        }
    }

    /// "Check Now" on the About page: ask straight away, whatever the switch says (a
    /// person asked), offer anything newer, and report back what was found.
    func checkNow(_ done: @escaping (Outcome, String?) -> Void) {
        lookUp { [weak self] outcome, release in
            if outcome == .newer, let release = release { self?.offer = release }
            done(outcome, release?.version)
        }
    }

    /// Calls back on the main queue.
    private func lookUp(_ done: @escaping (Outcome, Release?) -> Void) {
        let finish = { (outcome: Outcome, release: Release?) in
            DispatchQueue.main.async { done(outcome, release) }
        }
        guard let bundleID = Bundle.main.bundleIdentifier,
              var parts = URLComponents(string: Self.lookupURL) else {
            finish(.unavailable, nil); return
        }
        var query = [URLQueryItem(name: "bundleId", value: bundleID)]
        if let region = Locale.current.region?.identifier {
            query.append(URLQueryItem(name: "country", value: region.lowercased()))
        }
        parts.queryItems = query
        guard let url = parts.url else { finish(.unavailable, nil); return }

        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 10
        config.waitsForConnectivity = false                  // offline: give up, do not wait
        let session = URLSession(configuration: config)
        let installed = installedVersion
        let systemVersion = UIDevice.current.systemVersion

        session.dataTask(with: url) { [weak self] data, response, _ in
            session.finishTasksAndInvalidate()
            guard let data = data, (response as? HTTPURLResponse)?.statusCode == 200,
                  let found = try? JSONDecoder().decode(Lookup.self, from: data) else {
                finish(.unavailable, nil); return
            }
            DispatchQueue.main.async { self?.defaults.set(Date(), forKey: Key.lastCheck) }
            // Not in this country's store yet, or it needs a newer iOS than this device
            // has: there is nothing this device can update to.
            guard let entry = found.results.first,
                  Self.compare(entry.minimumOsVersion ?? "0", systemVersion) != .orderedDescending,
                  Self.compare(entry.version, installed) == .orderedDescending else {
                finish(.upToDate, nil); return
            }
            finish(.newer, Release(version: entry.version, appID: entry.trackId))
        }.resume()
    }

    private struct Lookup: Decodable {
        let results: [Entry]
        struct Entry: Decodable {
            let version: String
            let trackId: Int
            let minimumOsVersion: String?
        }
    }

    /// Version numbers compared part by part as numbers, so 1.10 is newer than 1.9 and
    /// 1.0 is the same as 1.0.0.
    static func compare(_ a: String, _ b: String) -> ComparisonResult {
        let x = a.split(separator: ".").map { Int($0) ?? 0 }
        let y = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(x.count, y.count) {
            let p = i < x.count ? x[i] : 0
            let q = i < y.count ? y[i] : 0
            if p != q { return p < q ? .orderedAscending : .orderedDescending }
        }
        return .orderedSame
    }

    // MARK: - Answering the alert

    /// "Not Now": say nothing more about this version for a week.
    func notNow() {
        guard let release = offer else { return }
        defaults.set(release.version, forKey: Key.notNowVersion)
        defaults.set(Date(), forKey: Key.notNowDate)
        offer = nil
    }

    private func saidNotNow(to version: String) -> Bool {
        guard defaults.string(forKey: Key.notNowVersion) == version,
              let when = defaults.object(forKey: Key.notNowDate) as? Date else { return false }
        return Date().timeIntervalSince(when) < Self.quietAfterNotNow
    }

    /// "Update": the App Store's own page for the app, as a sheet over the app.
    func openStore() {
        guard let release = offer else { return }
        offer = nil
        // Let the alert finish going away first; UIKit will not present over it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self = self, let top = Self.topViewController() else { return }
            let store = SKStoreProductViewController()
            store.delegate = self
            store.loadProduct(withParameters:
                [SKStoreProductParameterITunesItemIdentifier: NSNumber(value: release.appID)],
                completionBlock: nil)
            top.present(store, animated: true)
        }
    }

    func productViewControllerDidFinish(_ viewController: SKStoreProductViewController) {
        viewController.dismiss(animated: true)
    }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow }
        var top = window?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}
