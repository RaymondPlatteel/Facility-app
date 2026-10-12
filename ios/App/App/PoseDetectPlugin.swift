import Foundation
import UIKit
import Capacitor
import Vision

// Finds the hips and feet in a middle split photo with Apple's body pose detection. Runs on the phone, offline.

@objc(PoseDetectPlugin)
public class PoseDetectPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PoseDetectPlugin"
    public let jsName = "PoseDetect"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "detectSplit", returnType: CAPPluginReturnPromise)
    ]

    // Takes { image: base64 JPEG, already upright }. Resolves with hip, left and right as 0–1 fractions of the
    // image from its top-left corner, or found: false when no body with a hip and two legs is seen.
    @objc func detectSplit(_ call: CAPPluginCall) {
        guard let b64 = call.getString("image"),
              let data = Data(base64Encoded: b64),
              let cg = UIImage(data: data)?.cgImage else {
            call.reject("Could not read the photo.")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNDetectHumanBodyPoseRequest()
            do {
                try VNImageRequestHandler(cgImage: cg, orientation: .up, options: [:]).perform([request])
            } catch {
                call.resolve(["found": false])
                return
            }
            // Each point comes with Vision's own confidence (0 to 1), and whether a foot is really a knee standing in for it.
            var best: (score: Float, hip: CGPoint, a: CGPoint, b: CGPoint, hc: Float, ac: Float, bc: Float, aKnee: Bool, bKnee: Bool)?
            for obs in request.results ?? [] {
                guard let pts = try? obs.recognizedPoints(.all) else { continue }
                func joint(_ name: VNHumanBodyPoseObservation.JointName) -> VNRecognizedPoint? {
                    guard let p = pts[name], p.confidence > 0.15 else { return nil }
                    return p
                }
                func mid(_ a: VNRecognizedPoint?, _ b: VNRecognizedPoint?) -> (CGPoint, Float)? {
                    guard let a = a, let b = b else { return nil }
                    return (CGPoint(x: (a.location.x + b.location.x) / 2, y: (a.location.y + b.location.y) / 2),
                            (a.confidence + b.confidence) / 2)
                }
                // A straight leg's knee lies on the hip-to-foot line, so it stands in for a hidden ankle.
                func foot(_ ankle: VNHumanBodyPoseObservation.JointName, _ knee: VNHumanBodyPoseObservation.JointName) -> (VNRecognizedPoint, Bool)? {
                    if let a = joint(ankle) { return (a, false) }
                    if let k = joint(knee) { return (k, true) }
                    return nil
                }
                let hip: (CGPoint, Float)?
                if let root = joint(.root) { hip = (root.location, root.confidence) }
                else { hip = mid(joint(.leftHip), joint(.rightHip)) }
                guard let h = hip,
                      let l = foot(.leftAnkle, .leftKnee),
                      let r = foot(.rightAnkle, .rightKnee) else { continue }
                let score = h.1 + l.0.confidence + r.0.confidence
                if best == nil || score > best!.score {
                    best = (score, h.0, l.0.location, r.0.location, h.1, l.0.confidence, r.0.confidence, l.1, r.1)
                }
            }
            guard let b = best else {
                call.resolve(["found": false])
                return
            }
            // Vision's origin is the bottom-left; the web's is the top-left. Left and right are as seen on screen.
            func out(_ p: CGPoint) -> [String: Double] { ["x": Double(p.x), "y": Double(1 - p.y)] }
            let aIsLeft = b.a.x <= b.b.x
            let (left, right) = aIsLeft ? (b.a, b.b) : (b.b, b.a)
            let (lc, rc) = aIsLeft ? (b.ac, b.bc) : (b.bc, b.ac)
            let (lk, rk) = aIsLeft ? (b.aKnee, b.bKnee) : (b.bKnee, b.aKnee)
            call.resolve(["found": true, "hip": out(b.hip), "left": out(left), "right": out(right),
                          "confidence": ["hip": Double(b.hc), "left": Double(lc), "right": Double(rc)],
                          "kneeStandsIn": ["left": lk, "right": rk]])
        }
    }
}
