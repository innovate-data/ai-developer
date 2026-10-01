"""PyQt5 desktop GUI for ReSim.

Modules
-------
main_window   `MainWindow` with tabs and menus; `run_app()` entry point
deck_editor   deck editor (line numbers, highlighting, outline, validation)
highlighter   ECLIPSE syntax highlighter
model_builder form-based deck generator (uses the Qt-free `deckgen`)
deckgen       `DeckSpec` / `default_spec` / `generate_deck`
run_panel     simulation options, QThread worker, progress and log
viewer3d      3D / 2D slice property viewer (matplotlib)
vtk_view      interactive pyvista viewer, run as ``python -m resim.gui.vtk_view``
plots         summary vector plots

Launch with ``python -m resim.gui [deck.DATA|results.npz]``.
"""


def main(argv=None):
    """Start the GUI application (imports PyQt5 lazily)."""
    from .main_window import run_app
    return run_app(argv)
