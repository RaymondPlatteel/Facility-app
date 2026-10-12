import UIKit
import Capacitor

// The app's own plugins are registered here; the ones from packages register themselves.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PoseDetectPlugin())
    }
}
