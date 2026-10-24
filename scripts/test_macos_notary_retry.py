import subprocess
import unittest
from unittest.mock import patch

from macos_notary_retry import run_stapler


def result(code, message=""):
    return subprocess.CompletedProcess(["xcrun", "stapler"], code, message, "")


class StaplerRetryTests(unittest.TestCase):
    @patch("macos_notary_retry.time.sleep")
    @patch("macos_notary_retry.subprocess.run")
    def test_recovers_from_connection_loss(self, run, sleep):
        run.side_effect = [result(68, "NSURLErrorDomain Code=-1005"), result(0)]
        run_stapler("staple", "/tmp/Test.app")
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(5)
        self.assertEqual(run.call_args.args[0], ["xcrun", "stapler", "staple", "/tmp/Test.app"])

    @patch("macos_notary_retry.time.sleep")
    @patch("macos_notary_retry.subprocess.run")
    def test_does_not_retry_ticket_validation_failure(self, run, sleep):
        run.return_value = result(68, "Ticket validation failed")
        with self.assertRaises(subprocess.CalledProcessError):
            run_stapler("validate", "/tmp/Test.app")
        run.assert_called_once()
        sleep.assert_not_called()

    @patch("macos_notary_retry.time.sleep")
    @patch("macos_notary_retry.subprocess.run")
    def test_stops_after_four_network_failures(self, run, sleep):
        run.return_value = result(68, "NSURLErrorDomain Code=-1001")
        with self.assertRaises(subprocess.CalledProcessError):
            run_stapler("validate", "/tmp/Test.app")
        self.assertEqual(run.call_count, 4)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5, 10, 20])

    @patch("macos_notary_retry.time.sleep")
    @patch("macos_notary_retry.subprocess.run")
    def test_success_does_not_wait(self, run, sleep):
        run.return_value = result(0)
        run_stapler("validate", "/tmp/Test.app")
        run.assert_called_once()
        sleep.assert_not_called()


if __name__ == "__main__":
    unittest.main()
