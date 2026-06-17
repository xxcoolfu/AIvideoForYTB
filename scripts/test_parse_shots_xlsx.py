#!/usr/bin/env python3
import unittest

from parse_shots_xlsx import workbook_target_path


class WorkbookTargetPathTest(unittest.TestCase):
    def test_absolute_package_path(self):
        self.assertEqual(
            workbook_target_path("/xl/worksheets/sheet1.xml"),
            "xl/worksheets/sheet1.xml",
        )

    def test_relative_workbook_path(self):
        self.assertEqual(
            workbook_target_path("worksheets/sheet1.xml"),
            "xl/worksheets/sheet1.xml",
        )


if __name__ == "__main__":
    unittest.main()
