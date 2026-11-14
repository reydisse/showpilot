// Disposable Foundation cookie store: never reads or clears the user's store.
// Mirrors Expo SDK 54 and RN 0.81.5 request header construction, and the RN
// Networking.clearCookies implementation, using a private ephemeral store.
import Foundation

let store = URLSessionConfiguration.ephemeral.httpCookieStorage!
while let line = readLine() {
  do {
    let input = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
    let id = input["id"] as! Int
    let operation = input["operation"] as! String
    var result: [String: Any] = ["id": id]
    if operation == "clear" {
      let cookies = store.cookies ?? []
      for cookie in cookies { store.deleteCookie(cookie) }
      result["hadCookies"] = !cookies.isEmpty
      result["remaining"] = store.cookies?.count ?? 0
    } else {
      let url = URL(string: input["url"] as! String)!
      guard url.host == "app.showpilot.tech" else { throw URLError(.badURL) }
      if operation == "poison" {
        let cookie = HTTPCookie(properties: [
          .domain: url.host!, .path: "/", .secure: "TRUE",
          .name: input["cookieName"] as! String, .value: "stale.fixture",
        ])!
        store.setCookie(cookie)
        result["count"] = store.cookies?.count ?? 0
      } else {
        let request = NSMutableURLRequest(url: url)
        if input["credentials"] as? String == "include" {
          request.httpShouldHandleCookies = true
          request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: store.cookies(for: url) ?? [])
        } else {
          request.httpShouldHandleCookies = false
        }
        for (name, value) in input["headers"] as? [String: String] ?? [:] {
          request.addValue(value, forHTTPHeaderField: name)
        }
        result["headers"] = request.allHTTPHeaderFields ?? [:]
        result["ambientCookieCount"] = store.cookies(for: url)?.count ?? 0
      }
    }
    let data = try JSONSerialization.data(withJSONObject: result)
    print(String(decoding: data, as: UTF8.self))
    fflush(stdout)
  } catch {
    // No headers, cookie values or credentials are included in errors.
    print("{\"error\":\"Native cookie fixture failed\"}")
    fflush(stdout)
  }
}
