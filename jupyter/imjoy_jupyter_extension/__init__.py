# Jupyter Extension points
def _jupyter_nbextension_paths():
    return [
        dict(
            section="notebook",
            src="static",
            # directory in the `nbextension/` namespace
            dest="imjoy_jupyter_extension",
            # _also_ in the `nbextension/` namespace
            require="imjoy_jupyter_extension/imjoy-rpc",
        )
    ]
