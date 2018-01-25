import {Config} from 'metal-state';
import Component from 'metal-jsx';
import QueryRecyclerProvider from './QueryRecyclerProvider';

export default class ApolloProvider extends Component {
	static PROPS = {
		client: Config.required(),
	};

	getChildContext() {
		return {
			client: this.props.client,
		};
	}

	render() {
		return (
			<QueryRecyclerProvider>
				<span>{this.props.children}</span>
			</QueryRecyclerProvider>
		);
	}
}
