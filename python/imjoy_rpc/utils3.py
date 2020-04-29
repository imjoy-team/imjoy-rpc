"""Provide utils for Python 3 plugins."""
import asyncio

from .utils import Promise


def make_coro(func):
    """Wrap a normal function with a coroutine."""

    async def wrapper(*args, **kwargs):
        """Run the normal function."""
        return func(*args, **kwargs)

    return wrapper


class FuturePromise(Promise, asyncio.Future):
    """Represent a promise as a future."""

    def __init__(self, pfunc, loop):
        """Set up promise."""
        self.loop = loop
        Promise.__init__(self, pfunc)
        asyncio.Future.__init__(self)

    def resolve(self, result):
        """Resolve promise."""
        if self._resolve_handler or self._finally_handler:
            super().resolve(result)
        else:
            self.loop.call_soon(self.set_result, result)

    def reject(self, error):
        """Reject promise."""
        if self._catch_handler or self._finally_handler:
            super().reject(error)
        else:
            if error:
                self.loop.call_soon(self.set_exception, Exception(str(error)))
            else:
                self.loop.call_soon(self.set_exception, Exception())
