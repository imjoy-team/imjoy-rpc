![License](https://img.shields.io/github/license/imjoy-team/imjoy-rpc.svg)
![Build ImJoy RPC](https://github.com/imjoy-team/imjoy-rpc/workflows/Build%20ImJoy%20RPC/badge.svg)
![PyPI](https://img.shields.io/pypi/v/imjoy-rpc.svg?style=popout)

# ImJoy RPC

Symmetrical Transparent Remote Procedure Calls

The core library that powers [ImJoy](https://imjoy.io).

### Python library
```bash
pip install imjoy-rpc
```

### Javascript library

#### NPM
```
npm install imjoy-rpc
```

For RPC communication within the browser (typically connect from an iframe to the ImJoy core in the parent window):
```js
import { imjoyRPC } from 'imjoy-rpc';

imjoyRPC.setupRPC({name: 'My Awesome App'}).then((api)=>{
 // call api.export to expose your plugin api
})
```

If you want to connect to a remote imjoy engine server:
```js
import { imjoyRPCSocketIO } from 'imjoy-rpc';

imjoyRPCSocketIO.connectToServer({
    name: 'My Awesome App',
    workspace: "my-workspace",
    server_url: "https://api.imjoy.io",
    token: "2s39elrw....",
}).then((api)=>{
 // call api.export to expose your plugin api

})
```

#### Browser

To connect to the ImJoy core ( typically from an iframe):
```html
<script src="https://cdn.jsdelivr.net/npm/imjoy-rpc@latest/dist/imjoy-rpc.min.js"></script>
<script>
imjoyRPC.setupRPC({name: 'My Awesome App'}).then((api)=>{
 // call api.export to expose your plugin api
})
</script>
```


And for connecting to a remote imjoy engine:
```html
<script src="https://cdn.jsdelivr.net/npm/imjoy-rpc@latest/dist/imjoy-rpc-socketio.min.js"></script>
<script>
imjoyRPCSocketIO.connectToServer({
    name: 'My Awesome App',
    workspace: "my-workspace",
    server_url: "https://api.imjoy.io",
    token: "2s39elrw....",
}).then((api)=>{
 // call api.export to expose your plugin api

})
</script>
```

### [Jupyter notebook extension](https://github.com/imjoy-team/imjoy-jupyter-extension)

## imjoy-rpc handshaking protocol

To start a connection between the core and an rpc peer (a plugin), a handshaking process is required to exchange the api. For the rpc peer, it works like a service provider that takes a set of api from the core and produce a set of service functions. The handshaking defines the exchange of interface functions, as well as authentication and configuration.

Here is a schema illustrate the process: 
[imjoy-rpc handshaking protocol](https://docs.google.com/drawings/d/13aZQxh-JNSILyHZXR8q3WmeL9gVAC3tvvffi1TOoIok/edit?usp=sharing)

## Data type representation

ImJoy RPC is built on top of two-way transport layer. Currently, we support 4 types of transport layer: [Jupyter comm messages](https://jupyter-notebook.readthedocs.io/en/stable/comms.html), [Pyodide](https://github.com/iodide-project/pyodide), Google Colab, and SocketIO. Data with different types are encoded into a unified representation and sent over the transport layer. It will then be decoded into the same or corresponding data type on the other side.

The data representation is a JSON object (but can contain binary data, e.g. `ArrayBuffer` in JS or `bytes` in Python). The goal is to represent more complex data types with primitive types that are commonly supported by many programming language, including strings, numbers, boolean, bytes, list/array and dictionary/object.


| Javascript | Python | imjoy-rpc representation |
|------------|--------- | ---- |
| String   | str        | v |
| Number   | int/float | v |
| Boolean  |  bool     | v |
| null/undefined  | None    | v |
| ArrayBuffer | bytes  | v |
| Array([])   | list/tuple |[_encode(v)] |
| Object({})  | dict  | {_encode(v)} |
| Set | Set | {_rtype: "set", _rvalue: _encode(Array.from(v))} |
| Map | OrderedDict  |{_rtype: "orderedmap", _rvalue: _encode(Array.from(v))} |
| Error | Exception | { _rtype: "error", _rvalue: v.toString() } |
| Blob | BytesIO/StringIO  | { _rtype: "blob", _rvalue: v, _rmime: v.type } |
| DataView | memoryview  |  { _rtype: "memoryview", _rvalue: v.buffer }|
| TypedArray | 1-D numpy array*  |{_rtype: "typedarray", _rvalue: v.buffer, _rdtype: dtype} |
| tf.Tensor/nj.array | numpy array  |{_rtype: "ndarray", _rvalue: v.buffer, _rshape: shape, _rdtype: _dtype} |
| Function* | function/callable* | {_rtype: "interface", _rid: _rid, _rvalue: name} <br> {_rtype: "callback", _rvalue: id} |
| Class | class/dotdict()* | {...} |
| custom | custom | encoder(v) (default `_rtype` = encoder name) |

Notes:
 - `_encode(...)` in the imjoy-rpc representation means the type will be recursively encoded (decoded).
 - For any JS object or Python dictonary, if it has a key named `_rintf` and the value is set to true, then this object will be treated as an interface. All functions contained in the object/dictionary, including all the children dictionary at any level, will be treated as `interface` function. Otherwise, it will be encoded as `callback`. The difference is `interface` function can be called many times, but the `callback` function can only be called once (Also see "Remote Objects" below).
 - For n-D numpy array, there is no established n-D array library in javascript, the current behavior is, if there is `tf`(Tensorflow.js) detected, then it will be decoded into `tf.Tensor`. If `nj`(numjs) is detected, then it will be decoded into `nj.array`.
 - Typed array will be represented as numpy array if available, otherwise it will be converted to raw bytes.    
    Type Conversion
    | Javascript | Numpy  | _rdtype |
    | -- | -- | -- |
    | Int8Array | int8 | int8 |
    | Int16Array| int16 |int16 |
    |  Int32Array| int32 | int32 |
    |  Uint8Array| uint8 | uint8 |
    |  Uint16Array| uint16 | uint16 |
    |  Uint32Array| uint32 | uint32 |
    |  Float32Array| float32 | float32 |
    |  Float64Array| float64 | float64 |
    |  Array| array | array |
    |note: 64-bit integers (signed or unsigned) are not supported|

 - `dotdict` in Python is a simple wrapper over `dict` that support using the dot notation to get item, similar to what you can do with Javascript object.

 ## Encoding and decoding custom objects
 For the data or object types that are not in the table above, for example, a custom class, you can support them by register your own `codec`(i.e. encoder and decoder) with `api.registerCodec()`.

 You need to provide a `name`, a `type`, `encoder` and `decoder` function. For example: in javascript, you can call `api.registerCodec({"name": "my_custom_codec", "type": MyClass, "encoder": (obj)=>{ ... return encoded;}, "decoder": (obj)=>{... return decoded;})`, or in Python you can do `api.registerCodec(name="my_custom_codec", type=MyClass, encoder=my_encoder_func, decoder=my_decoder_func)`.
 

 The basic idea of using a custom codec is to use the `encoder` to represent your custom data type into array/dictionary of primitive types (string, number etc.) such that they can be send via the transport layer of imjoy-rpc. Then use the `decoder` to reconstruct the object remotely based on the representation.

For the `name`, it will be assigned as `_rtype` for the data representation, therefore please be aware that you should not use a name that already used internally (see the table above), unless you want to overried the default encoding. Also note that you cannot overried the encoding of primitive types and functions.

The `encoder` function take an object as input and you need to return the represented object/dictionary. You can only use primitive types plus array/list and object/dict in the represented object. If you want to include function in the encoding, please also include a key `_rintf` and set the value to true. By default, if your returned object does not contain a key `_rtype`, the codec `name` will be used as `_rtype`. You can also assign a different `_rtype` name, that allows the conversion between different types.

The `decoder` function converts the encoded object into the actual object. It will only be called when the `_rtype` of an object matches the `name` of the codec.

### Support Zarr Array encoding
[Zarr](https://zarr.readthedocs.io/en/stable/) is a more scalable n-dimensional array format that has a numpy-like api and can be used with multiple backends. It is ideally suited for sending large n-dimensional array between imjoy-rpc peers in a lazy fashion. We have an [internal implementation] of codec that can support sending.

To use it, you can call import and call `register_default_codecs`.
```python
from imjoy_rpc import register_default_codecs
register_default_codecs()
```

If you don't want to register all the default codecs, you can also pass an list of default codec names:
```python
from imjoy_rpc import register_default_codecs
register_default_codecs(['zarr.Array', 'zarr.Group'])
```

### Example 1: encoding and decoding custom classes with imjoy-rpc
In this example, we first define a `Cat` class, then we register a codec to do encoding and decoding of the `Cat` instances.

```javascript
class Cat{
  constructor(name, color, age, clean){
    this.name = name
    this.color = color
    this.age = age
    this.clean = clean
  }
}

api.registerCodec({
    'name': 'cat', 
    'type': Cat, 
    'encoder': (obj)=>{
        // convert the Cat instance as a dictionary with all the properties
        return {name: obj.name, color: obj.color, age: obj.age, clean: obj.clean}
    },
    'decoder': (encoded_obj)=>{
        // recover the Cat instance
        return new Cat(encoded_obj.name, encoded_obj.color, encoded_obj.age, encoded_obj.clean)
    }
})

class Plugin {
    async setup(){
    }
    async run(){
        const dirtyCat = new Cat('boboshu', 'mixed', 0.67, false)
        // assuming we have a shower plugin
        const showerPlugin = await api.getPlugin('catShower')
        // now pass a cat into the shower plugin, and we should get a clean cat, the name should be the same
        // note that the other plugin is running in another sandboxed iframe or in Python
        // because we have the cat codec registered, we can send the Cat object to the other plugin
        // Also notice that the other plugin should also define custom encoding decoding following the same representation
        const cleanCat = await showerPlugin.wash(dirtyCat)
        if(cleanCat.clean) api.alert(cleanCat.name + ' is clean.')
    }
};
api.export(new Plugin())
```

Note that, you need to implement the same encoding and decoding for the two connection peers. Otherwise the object will remain undecoded.

### Example 2: sending `itk.Image` from Python to Javascript

Here is another example for supporting a new type `itk.Image` for displaying 2D/3D image in Python in the itk-vtk-viewer (Javascript). 

We will first encode all the itk.Image instances with the `itkimage_to_json` function.

```python
# Run `pip install itk itkwidgets` before trying this example
from imjoy_rpc import api
import numpy as np
import itk
from itkwidgets.trait_types import itkimage_to_json, itkimage_from_json
from itkwidgets._transform_types import to_itk_image

# register an encoder for encoding the itk.Image, the name `itkimage` will be used for decoding
# this example only use the encoder part
api.registerCodec({'name': 'itkimage', 'type': itk.Image, 'encoder': itkimage_to_json, 'decoder': itkimage_from_json})

class ImJoyPlugin():
    def setup(self):
        api.log('plugin initialized')

    async def run(self, ctx):
        image_array = np.random.randint(0, 255, [10,10,10], dtype='uint8')
        itk_image = to_itk_image(image_array)
        # here the itk_image will be encoded via the registered encoder function (i.e.: itkimage_to_json)
        api.createWindow(type="itk-vtk-viewer", src="https://oeway.github.io/itk-vtk-viewer/", data={"image_array": itk_image})

api.export(ImJoyPlugin())
```

For the Javascript part, we also need a codec to decode the itkImage, we will use an existing function called `decompressImage`. Here is the implementation we made for the viewer served on https://oeway.github.io/itk-vtk-viewer/:

```javascript

// register a decoder to decode custom type `itkimage`
api.registerCodec({name: 'itkimage', decoder: itkVtkViewer.utils.decompressImage})

api.export({
    setup() {
        api.log("itk-vtk-viewer loaded successfully.")
    },
    async run(ctx) {
        await this.imshow(ctx.data.image_array)
    },
    async imshow(image_array) {
        // image_array is the decoded image
        const vtkImage = itkVtkViewer.utils.vtkITKHelper.convertItkToVtkImage(image_array)
        const dims = vtkImage.getDimensions()
        const is2D = dims.length === 2 || (dims.length === 3 && dims[2] === 1)
        itkVtkViewer.createViewer(container, {
            image: vtkImage,
            pointSets: null,
            geometries: null,
            use2D: is2D,
            rotate: false
        })
    }
})
```

### Example 3: sending lazy object

Since an encoder can also contain function, this allow us to make a lazy object that can be used to fetch data gradually.
```python
# Run `pip install dask[array]` before trying this example
from imjoy_rpc import api
import dask.array as da
import numpy as np

def lazy_encoder(obj):
    encoded = {}

    # slicing on the array with a list of slices, each slice list uses [start, stop, step] format
    # the default step is 1
    # for example get_slice([(0, 10, 2), (0, 1)])
    def get_slice(slices):
        indexes = tuple([slice(s[0], s[1], None if len(s)==2 else s[2]) for s in slices])
        return np.array(obj[indexes].compute())

    encoded["slice"] = get_slice
    encoded["_rintf"] = True
    return encoded


api.registerCodec({'name': 'daskimage', 'type': da.Array, 'encoder': lazy_encoder})

class ImJoyPlugin():
    def setup(self):
        api.log('plugin initialized')

    async def run(self, ctx):
        # make a dask array
        array1 = da.random.random((10000, 10000), chunks=(1000, 1000))
        # Send the array and get it back,
        # because of the decoding, we will get an slice interface to the array instead
        array2 = await api.echo(array1)
        
        # Here we use the echo function as an example
        # but you can also send this array to, for example a javascript plugin,
        # it can bet the same slice function
        # we perform slicing on two dimensions
        # start=0, stop=4, step=2 for the first dimension
        # start=5, stop=6 for the second dimension
        slices = await array2.slice([[0, 4, 2], [5, 6]])

        api.alert(str(slices))

        # dispose the array when we don't need it
        api.disposeObject(array2)

api.export(ImJoyPlugin())
```

### Example 4: passing Zarr array from Python to Javascript
[Zarr](https://zarr.readthedocs.io/en/stable/) is an emerging standard for storing or serving chunked, compressed N-dimensional arrays. It is ideally suited for storing large amount of data remotely. For example, we can use store large images in zarr format on a blob storage (e.g. AWS S3) and visualize it in a web app. With imjoy-rpc, we can define a custom codec for zarr arrays/groups to support sending Zarr arrays, for example from Python to Javascript (use [zarr.js](https://github.com/gzuidhof/zarr.js/)).


This is the codec looks like in Python:

```python
import zarr
from imjoy import api
from tifffile import imread

def encode_zarr_store(zobj):
    def getItem(key):
        return zobj.store[key]

    def setItem(key, value):
        zobj.store[key] = value

    def containsItem(key):
        return key in zobj.store

    return {
        "_rintf": True,
        "_rtype": 'zarr-array' if isinstance(zobj, zarr.Array) else 'zarr-group',
        "getItem": getItem,
        "setItem": setItem,
        "containsItem": containsItem,
    }

api.registerCodec({'name': 'zarr-array', 'type': zarr.Array, "encoder": encode_zarr_store})
api.registerCodec({'name': 'zarr-group', 'type': zarr.hierarchy.Group, "encoder": encode_zarr_store})

...
    def run(self, ctx):
        image = imread('cell_membranes.tif')
        image = (image*65536).astype('uint16')
        z_array = zarr.array(image, chunks=(50, 50))
        ...
        # let's assume viewer is a web app that supports imjoy-rpc
        # 
        viwer.imshow(z_array)
```

The encoded object can be directly used as a zarr array or group for zarr.js:

This is the relevant part in the viwer plugin in Javascript:
```js

// assuming that we already loaded zarr.js

function imshow(z_array){
    // we don't need an decoder, the z_array object can be directly read by zarr.openArray
    zarrArr = await zarr.openArray({ store: z_array });
    ...
}
```
For an real example notebook, see [here](https://gist.github.com/oeway/ebedc17c9ab1f6aa5eee181679d85b5f) for the source code or try it on Binder: [![Binder](https://mybinder.org/badge_logo.svg)](https://mybinder.org/v2/gist/oeway/ebedc17c9ab1f6aa5eee181679d85b5f/master?filepath=vitessce-image-viewer-imjoy-demo.ipynb)


## Remote Objects

When sending an object (a JS `Object`, `Class` or Python `dict`, `class`) remotely via imjoy-rpc, a proxy object will be created on the other side. The object can contain supported data types which will be send directly to remote locations.

Specifically for the methods contained in the object, there are two types of encoding modes (`interface` and `callback`). The difference is that a remote method encoded as `callback` can only be called once and will be destroyed after calling, and `interface` mode can be used without this limitation. 

The two types can be switched automatically or manually:
 * if the object contains a key or property: `_rintf` and the value is true, then all the member function will be treated as `interface` recursively.
 * if the object is not a basic `Object`/`array` or `dict`/`list` but other general class, then it will be treated as `interface`.

Note: if a method's name starts with `_`, it will not be sent and mapped remotely.

Importantly, When an object is sent to remote location, the object will be stored in an internal object store. Because the object store will always hold object, it will not be possible for the garbage collector to recycle the resources. To get rid of this issue, you need to dispose the remote object manually by calling `api.disposeObject(obj)` function. This will notify the remote peer to remove the object from the object store, such that the garbage collector can then collect the occupied resources.

**Therefore, please always call `api.disposeObject(obj)` when you don't need a remote object anymore.** This is necessary only for those object encoded in `interface` mode.
