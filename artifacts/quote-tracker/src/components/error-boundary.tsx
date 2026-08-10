import React from "react"
import { AlertTriangle } from "lucide-react"

interface State {
  hasError: boolean
  error?: Error
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; resetKey?: any },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidUpdate(prevProps: { resetKey?: any }) {
    if (prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: undefined })
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[400px] flex-col items-center justify-center p-6 text-center">
          <div className="rounded-full bg-destructive/10 p-4 mb-4">
            <AlertTriangle className="h-8 w-8 text-destructive" />
          </div>
          <h2 className="mb-2 text-2xl font-bold">Something went wrong</h2>
          <p className="mb-6 max-w-md text-muted-foreground text-sm">
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => this.setState({ hasError: false })}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      )
    }

    return this.props.children
  }
}