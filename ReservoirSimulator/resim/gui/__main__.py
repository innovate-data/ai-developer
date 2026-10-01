"""Launch the ReSim GUI:  python -m resim.gui [deck.DATA | results.npz ...]"""
import sys

from .main_window import run_app

if __name__ == "__main__":
    sys.exit(run_app(sys.argv))
