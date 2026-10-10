class RunError(Exception):
    """An attempt that ends with a stored failure code. `retryable` follows the attempts policy."""

    def __init__(self, code: str, retryable: bool):
        super().__init__(code)
        self.code = code
        self.retryable = retryable


class LeaseLost(Exception):
    """The run is no longer ours (expired, re-claimed, or finished). Stop without writing: the claim logic owns it."""
