"""Small reusable widgets."""
from __future__ import annotations

from PyQt5.QtGui import QValidator
from PyQt5.QtWidgets import QDoubleSpinBox


class SciSpinBox(QDoubleSpinBox):
    """QDoubleSpinBox that displays/accepts compact or scientific notation (e.g. 4e-06, 8325)."""

    def __init__(self, value=0.0, lo=-1e15, hi=1e15, step=1.0, sig=8, parent=None):
        super().__init__(parent)
        self._sig = sig
        self.setDecimals(15)
        self.setRange(lo, hi)
        self.setSingleStep(step)
        self.setKeyboardTracking(False)
        self.setValue(value)

    def textFromValue(self, value):  # noqa: N802 (Qt API)
        return f"{value:.{self._sig}g}"

    def valueFromText(self, text):  # noqa: N802
        try:
            return float(text.replace(",", "."))
        except ValueError:
            return self.value()

    def validate(self, text, pos):
        t = text.strip().replace(",", ".")
        if not t:
            return QValidator.Intermediate, text, pos
        try:
            v = float(t)
        except ValueError:
            if t in ("-", "+", ".") or t[-1:] in ("e", "E", "-", "+"):
                return QValidator.Intermediate, text, pos
            return QValidator.Invalid, text, pos
        if not (self.minimum() <= v <= self.maximum()):
            return QValidator.Intermediate, text, pos
        return QValidator.Acceptable, text, pos

    def stepBy(self, steps):  # noqa: N802
        """Additive steps, or multiplicative (x10) for values spanning decades when step is 0."""
        if self.singleStep() == 0:
            v = self.value() * (10.0 ** steps)
            self.setValue(min(max(v, self.minimum()), self.maximum()))
        else:
            super().stepBy(steps)


def format_date(s) -> str:
    """'2019-10-29T19:12:00' -> '2019-10-29' (other strings are returned unchanged)."""
    s = str(s)
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    return s
