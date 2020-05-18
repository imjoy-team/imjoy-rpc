ImJoy RPC
============


## Using ImJoy with Jupyter notebooks

The imjoy-rpc library enables bidirectional RPC calls between the ImJoy core and your python plugin.

The library has an abstract transport interface that can support different types of transport. For now, we support [Jupyter comms message](https://jupyter-notebook.readthedocs.io/en/stable/comms.html) which is a custom message protocol used in Jupyter notebooks (for example powers jupyter widgets).

To use it, you need to install the imjoy-rpc library in Python and the notebook extension in javascript.

### Install ImJoy RPC library
```bash
pip install imjoy-rpc
```

### Install Jupyter notebook extension

```bash
# install the extension
jupyter nbextension install https://raw.githubusercontent.com/imjoy-team/imjoy-rpc/master/nbextension/imjoy-rpc.js

# for development, you can clone this repo and add --symlink
# git clone https://github.com/imjoy-team/imjoy-rpc.git
# cd imjoy-rpc
# jupyter nbextension install nbextension/imjoy-rpc.js --symlink

# enable the extension
jupyter nbextension enable imjoy-rpc

# you can also disabled it if you don't need it anymore
# jupyter nbextension disable imjoy-rpc
```

### Use ImJoy plugins inside Jupyter notebooks
Now you can start a jupyter notebook via for example `jupyter notebook` command, you should be able to see an ImJoy icon in the toolbar if everything goes well.

Now run the following code in a cell:
```python
import asyncio
from imjoy_rpc import api

class ImJoyPlugin():
    def setup(self):
        api.log('plugin initialized')

    async def run(self, ctx):
        api.alert('hello world')

api.export(ImJoyPlugin())
```

With the above code, you created an ImJoy plugin. To run it, click the Run button with the ImJoy icon. It will then call the run function of your plugin.

### Run Jupyter notebook inside ImJoy

You can also do the reverse by running a notebook inside ImJoy, to do that, please first create a jupyter notebook with the same code as above. Then copy and paste the url into the "+ PLUGINS" dialog, press enter and install the plugin. Click the newly installed plugin and you will get a notebook page open in ImJoy.

Similarily, if you now click the run ImJoy button, you can interact with ImJoy in the notebook.
