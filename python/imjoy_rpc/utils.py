"""Provide utils for Python 2 plugins."""
import copy
import threading
import time
import uuid
from importlib import import_module


class Registry(dict):
    """Registry of items."""

    # https://github.com/home-assistant/home-assistant/blob/
    # 2a9fd9ae269e8929084e53ab12901e96aec93e7d/homeassistant/util/decorator.py
    def register(self, name):
        """Return decorator to register item with a specific name."""

        def decorator(func):
            """Register decorated function."""
            self[name] = func
            return func

        return decorator


def get_psutil():
    """Try to import and return psutil."""
    try:
        return import_module("psutil")
    except ImportError:
        print(
            "WARNING: a library called 'psutil' can not be imported, "
            "this may cause problem when killing processes."
        )
        return None


def debounce(secs):
    """Decorate to ensure function can only be called once every `s` seconds."""

    def decorate(func):
        store = {"t": None}

        def wrapped(*args, **kwargs):
            if store["t"] is None or time.time() - store["t"] >= secs:
                result = func(*args, **kwargs)
                store["t"] = time.time()
                return result
            return None

        return wrapped

    return decorate


def set_interval(interval):
    """Set interval."""

    def decorator(function):
        def wrapper(*args, **kwargs):
            stopped = threading.Event()

            def loop():  # executed in another thread
                while not stopped.wait(interval):  # until stopped
                    function(*args, **kwargs)

            thread = threading.Thread(target=loop)
            thread.daemon = True  # stop if the program exits
            thread.start()
            return stopped

        return wrapper

    return decorator


class dotdict(dict):  # pylint: disable=invalid-name
    """Access dictionary attributes with dot.notation."""

    __getattr__ = dict.get
    __setattr__ = dict.__setitem__
    __delattr__ = dict.__delitem__

    def __deepcopy__(self, memo=None):
        """Make a deep copy."""
        return dotdict(copy.deepcopy(dict(self), memo=memo))


def get_key_by_value(dict_, value):
    """Return key by value."""
    for key, val in dict_.items():
        if value == val:
            return key
    return None


def format_traceback(traceback_string):
    """Format traceback."""
    formatted_lines = traceback_string.splitlines()
    # remove the second and third line
    formatted_lines.pop(1)
    formatted_lines.pop(1)
    formatted_error_string = "\n".join(formatted_lines)
    formatted_error_string = formatted_error_string.replace(
        'File "<string>"', "Plugin script"
    )
    return formatted_error_string


class ReferenceStore:
    """Represent a reference store."""

    def __init__(self):
        """Set up store."""
        self._store = {}

    @staticmethod
    def _gen_id():
        """Generate an id."""
        return str(uuid.uuid4())

    def put(self, obj):
        """Put an object into the store."""
        id_ = self._gen_id()
        self._store[id_] = obj
        return id_

    def fetch(self, search_id):
        """Fetch an object from the store by id."""
        if search_id not in self._store:
            return None
        obj = self._store[search_id]
        if not hasattr(obj, "__remote_method"):
            del self._store[search_id]
        if hasattr(obj, "__jailed_pairs__"):
            _id = get_key_by_value(self._store, obj.__jailed_pairs__)
            self.fetch(_id)
        return obj


class Promise(object):  # pylint: disable=useless-object-inheritance
    """Represent a promise."""

    def __init__(self, pfunc):
        """Set up promise."""
        self._resolve_handler = None
        self._finally_handler = None
        self._catch_handler = None

        def resolve(*args, **kwargs):
            self.resolve(*args, **kwargs)

        def reject(*args, **kwargs):
            self.reject(*args, **kwargs)

        pfunc(resolve, reject)

    def resolve(self, result):
        """Resolve promise."""
        try:
            if self._resolve_handler:
                self._resolve_handler(result)
        except Exception as exc:  # pylint: disable=broad-except
            if self._catch_handler:
                self._catch_handler(exc)
            elif not self._finally_handler:
                print("Uncaught Exception: {}".format(exc))
        finally:
            if self._finally_handler:
                self._finally_handler()

    def reject(self, error):
        """Reject promise."""
        try:
            if self._catch_handler:
                self._catch_handler(error)
            elif not self._finally_handler:
                print("Uncaught Exception: {}".format(error))
        finally:
            if self._finally_handler:
                self._finally_handler()

    def then(self, handler):
        """Implement then callback.

        Set handler and return the promise.
        """
        self._resolve_handler = handler
        return self

    def finally_(self, handler):
        """Implement finally callback.

        Set handler and return the promise.
        """
        self._finally_handler = handler
        return self

    def catch(self, handler):
        """Implement catch callback.

        Set handler and return the promise.
        """
        self._catch_handler = handler
        return self
